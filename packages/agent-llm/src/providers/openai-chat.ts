/**
 * OpenAI Chat Completions 方言（官方 + 兼容网关共用）：线级传输走 provider-utils
 * 直连（wire.ts），厂商差异（思考字段、缓存键）由 provider 配置声明，透传字段原样序列化。
 */
import type { LlmRequest, LlmResult, LlmStreamHandler, ProviderContinuationState, TokenUsage } from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import type { AttemptGuard } from "../transport.js";
import { StreamingBlocks } from "./internal/stream-blocks.js";
import { compactRecord } from "../record-utils.js";
import { buildThinkingParams, thinkingSideEffectsActive } from "../thinking.js";
import { isRecord } from "../internal/records.js";
import { extractOpenAiUsage } from "../internal/usage.js";
import { providerTypeSpec } from "../provider-registry.js";
import { resolveProviderHeaders } from "../provider-headers.js";
import {
  consumeProviderStream,
  resolveSdkFetch,
  executeProviderOperation,
  openAiMethodUrl,
  requireApiKey,
  settleAsyncIterator,
  withProviderGuards,
} from "../transport.js";
import { postWireJson, postWireSse, type WireCallOptions, type WireEventStream } from "./wire.js";

/** OpenAI 兼容方言中 assistant 消息可能承载思考文本的线字段（解析与补齐共用）。 */
const REASONING_WIRE_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"] as const;

/**
 * 补齐用思考线字段：provider 的 reasoning_field 声明（目录 interleaved.field 推导，
 * openrouter 部分模型为 reasoning_details），缺省 reasoning_content（DeepSeek/qwen 系方言）。
 */
function reasoningFieldOf(provider: LlmRequest["provider"]): string {
  return (provider as Record<string, unknown>).reasoning_field === "reasoning_details"
    ? "reasoning_details"
    : "reasoning_content";
}

export class OpenAiChatAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const completion = await guard.total(
          postWireJson(buildWireOptions(request, guard, buildChatBody(request))),
        );
        return parseCompletion(completion);
      }),
    );
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const events = await guard.total(
          postWireSse(buildWireOptions(request, guard, buildChatBody(request, true))),
        );
        return consumeProviderStream(onChunk, (emit) => consumeChatStream(events, request, guard, emit));
      }),
    );
  }
}

/** 线级调用参数：按请求构造（fetch 惰性解析，测试 stub globalThis.fetch 依赖这一点）；重试/超时归策略层。 */
function buildWireOptions(request: LlmRequest, guard: AttemptGuard, body: Record<string, unknown>): WireCallOptions {
  const provider = request.provider;
  return {
    url: openAiMethodUrl(provider, "/chat/completions"),
    headers: {
      authorization: `Bearer ${requireApiKey(provider)}`,
      ...resolveProviderHeaders(provider, request.promptCacheKey),
    },
    body,
    signal: guard.signal,
    fetch: resolveSdkFetch(provider),
  };
}

export function buildChatBody(request: LlmRequest, stream = false): Record<string, unknown> {
  const thinkingParams = buildThinkingParams(request.provider, request.thinkingLevel);
  const promptCacheParams = buildPromptCacheParams(request);
  const messages = request.messages.map(stripInternalMessageFields);
  // 思考模式下统一补齐缺失的 reasoning 字段（与厂商无关）：思考块随轨迹回放是通用规范，
  // 字段在场是 DeepSeek 等官方 API 的硬性要求（带 tools 时含未调工具的纯文字轮，缺失 400）；
  // 其余兼容网关忽略未知消息字段。激活判定 = 档位显式开启且形状会产出思考参数
  // （effort/toggle）——kind=none / budget 覆盖时请求体无思考参数，陈旧档位不得注入字段。
  // 补哪个字段名由 provider 的 reasoning_field 声明（目录 interleaved.field 推导，如
  // openrouter 部分模型的 reasoning_details），缺省 reasoning_content；已带任一思考字段的轮不重复补。
  if (thinkingSideEffectsActive(request.provider, request.thinkingLevel)) {
    const padField = reasoningFieldOf(request.provider);
    for (const message of messages) {
      if (message.role === "assistant" && !REASONING_WIRE_FIELDS.some((key) => message[key] !== undefined)) {
        message[padField] = "";
      }
    }
  }
  return {
    ...compactRecord(request.extraParams),
    model: request.model,
    messages,
    temperature: request.temperature ?? undefined,
    // 统一使用现代 token 字段（不按格式/思考特判）：OpenAI 官方新模型只认它，
    // 兼容网关不识别时按自身默认限额处理（未知字段被忽略）。
    max_completion_tokens: request.maxCompletionTokens ?? undefined,
    ...(thinkingParams ?? {}),
    ...promptCacheParams,
    tools: request.tools && request.tools.length > 0 ? request.tools.map(stripInternalToolFields) : undefined,
    tool_choice: request.tools && request.tools.length > 0 ? (request.toolChoice ?? "auto") : undefined,
    stream: stream ? true : undefined,
    ...(stream && (providerTypeSpec(request.provider.provider_type)?.supportsStreamUsageOptions ?? true)
      ? { stream_options: { include_usage: true } }
      : {}),
  };
}

function buildPromptCacheParams(request: LlmRequest): Record<string, unknown> {
  if (request.provider.supports_prompt_caching === false) return {};
  const capabilities = providerTypeSpec(request.provider.provider_type);
  if (!capabilities || capabilities.promptCacheMode === "none") return {};
  // prompt_cache_key 仅 OpenAI 官方端点确定支持；其他厂商的缓存参数经 provider
  // extra_params 静态声明（厂商层适配，不在调用层按厂商分派）。
  if (capabilities.supportsPromptCacheKey && request.promptCacheKey && supportsOpenAiPromptCacheKey(request)) {
    return { prompt_cache_key: request.promptCacheKey };
  }
  return {};
}

function supportsOpenAiPromptCacheKey(request: LlmRequest): boolean {
  if (request.provider.supports_prompt_caching === true) return true;
  const endpoint = typeof request.provider.api_endpoint === "string" ? request.provider.api_endpoint.trim() : "";
  if (!endpoint) return true;
  try {
    return new URL(endpoint).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function stripInternalMessageFields(message: LlmRequest["messages"][number]): Record<string, unknown> {
  const {
    reasoning_blocks: _reasoningBlocks,
    provider_continuation,
    // name（tool 消息的工具名）是 OpenAI 已弃用的可选字段，调用关联靠 tool_call_id 即可；
    // 严格网关（opencode Console Go 等）对其直接 400，统一不下发。Gemini 原生方言仍需该值，仅在彼处消费。
    name: _name,
    ...wireMessage
  } = message;
  const assistantFields = message.role === "assistant" && provider_continuation?.protocol === "openai_chat"
    ? provider_continuation.assistantFields
    : null;
  if (assistantFields) return { ...copyOpenAiChatAssistantFields(assistantFields), ...wireMessage };
  return wireMessage;
}

// source 是 runtime 侧的来源标记（上下文构成估算用），不属于 wire 协议；
// OpenAI 兼容网关对 tools 未知字段可能直接 400，必须与 messages 一样剥离内部字段。
function stripInternalToolFields(tool: NonNullable<LlmRequest["tools"]>[number]): Record<string, unknown> {
  const { source: _source, ...wireTool } = tool;
  return wireTool;
}

function parseCompletion(body: Record<string, unknown>): LlmResult {
  const choice = firstChoice(body);
  const message = choice && isRecord(choice.message) ? choice.message : null;
  const content = message ? extractTextContent(message.content) : extractTextContent(choice?.text);
  const reasoning = message ? extractReasoning(message) : "";
  const toolCalls = message ? parseToolCalls(message.tool_calls) : [];
  const finishReason = choice && typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  if (!content && !reasoning && toolCalls.length === 0) {
    throw new Error(`LLM response did not include assistant content (finishReason=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, raw: body, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  const assistantFields = message ? copyOpenAiChatAssistantFields(message) : {};
  const continuation = buildOpenAiChatContinuation(toolCalls, assistantFields);
  if (continuation) result.providerContinuation = continuation;
  const usage = extractOpenAiUsage(body) ?? extractChoiceUsage(body);
  if (usage) result.usage = usage;
  return result;
}

async function consumeChatStream(
  events: WireEventStream,
  request: LlmRequest,
  guard: AttemptGuard,
  onChunk: LlmStreamHandler,
): Promise<LlmResult> {
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  let stopped = false;
  const blocks = new StreamingBlocks();
  const assistantFields: Record<string, unknown> = {};
  const iterator = events[Symbol.asyncIterator]();

  try {
    while (true) {
      const result = await guard.next(iterator.next());
      if (result.done) break;
      const chunk = result.value;
      // Moonshot 等网关把 usage 放在 choice 上而非顶层，取 top-level 失败时回退。
      usage = extractOpenAiUsage(chunk) ?? extractChoiceUsage(chunk) ?? usage;
      const choice = firstChoice(chunk);
      if (!choice) continue;
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      const delta = isRecord(choice.delta) ? choice.delta : choice;
      accumulateToolCalls(delta.tool_calls, blocks);
      accumulateOpenAiChatAssistantFields(delta, assistantFields);
      const reasoningDelta = extractReasoning(delta);
      reasoning += reasoningDelta;
      const text = extractTextContent(delta.content) || extractTextContent(choice.text);
      if (text || reasoningDelta) {
        if (text) content += text;
        const control = await onChunk({ content: text, ...(reasoningDelta ? { reasoning: reasoningDelta } : {}), finishReason, raw: chunk });
        if (control?.stop) {
          stopped = true;
          break;
        }
      }
      if (finishReason === "interrupted") break;
    }
    guard.throwIfAborted();
  } finally {
    await settleAsyncIterator(iterator);
  }

  const toolCalls = blocks.toolCalls();
  if (toolCalls.length > 0 && !stopped) await onChunk({ content: "", finishReason, toolCalls });
  if (!content && !reasoning && toolCalls.length === 0 && finishReason !== "interrupted" && !stopped && !request.allowEmptyStream) {
    throw new Error(`LLM streaming response did not include assistant content (finishReason=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  const continuation = buildOpenAiChatContinuation(toolCalls, assistantFields);
  if (continuation) result.providerContinuation = continuation;
  if (usage) result.usage = usage;
  return result;
}

/** usage-on-choice 回退：部分网关（Moonshot 系）把 usage 挂在 choice 上而非顶层。 */
function extractChoiceUsage(body: Record<string, unknown>): ReturnType<typeof extractOpenAiUsage> {
  const choice = firstChoice(body);
  return choice && isRecord(choice.usage) ? extractOpenAiUsage({ usage: choice.usage }) : null;
}

function firstChoice(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) return null;
  return isRecord(body.choices[0]) ? body.choices[0] : null;
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!isRecord(part)) return "";
    if (typeof part.text === "string") return part.text;
    if (part.type === "text" && isRecord(part.text) && typeof part.text.value === "string") return part.text.value;
    return "";
  }).join("");
}

function extractReasoning(value: Record<string, unknown>): string {
  for (const key of ["reasoning_content", "reasoning"] as const) {
    if (typeof value[key] === "string") return value[key];
  }
  if (!Array.isArray(value.reasoning_details)) return "";
  return value.reasoning_details.map((detail) => {
    if (!isRecord(detail)) return "";
    if (typeof detail.text === "string") return detail.text;
    if (typeof detail.content === "string") return detail.content;
    return "";
  }).join("");
}

function copyOpenAiChatAssistantFields(value: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof value.reasoning_content === "string") fields.reasoning_content = value.reasoning_content;
  if (typeof value.reasoning === "string") fields.reasoning = value.reasoning;
  if (Array.isArray(value.reasoning_details)) {
    fields.reasoning_details = value.reasoning_details.filter(isRecord).map((item) => ({ ...item }));
  }
  return fields;
}

function accumulateOpenAiChatAssistantFields(delta: Record<string, unknown>, target: Record<string, unknown>): void {
  for (const key of ["reasoning_content", "reasoning"] as const) {
    if (typeof delta[key] === "string") target[key] = `${typeof target[key] === "string" ? target[key] : ""}${delta[key]}`;
  }
  if (Array.isArray(delta.reasoning_details)) {
    target.reasoning_details = mergeReasoningDetails(target.reasoning_details, delta.reasoning_details);
  }
}

function mergeReasoningDetails(previous: unknown, next: unknown[]): Record<string, unknown>[] {
  const output = Array.isArray(previous) ? previous.filter(isRecord).map((item) => ({ ...item })) : [];
  for (const item of next) {
    if (!isRecord(item)) continue;
    const key = reasoningDetailKey(item);
    const existingIndex = key ? output.findIndex((candidate) => reasoningDetailKey(candidate) === key) : -1;
    if (existingIndex < 0) {
      output.push({ ...item });
      continue;
    }
    output[existingIndex] = mergeReasoningDetail(output[existingIndex] ?? {}, item);
  }
  return output;
}

function reasoningDetailKey(value: Record<string, unknown>): string | null {
  if (typeof value.index === "number") return `index:${value.index}`;
  if (typeof value.id === "string" && value.id) return `id:${value.id}`;
  return null;
}

function mergeReasoningDetail(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (["text", "content", "data", "summary", "encrypted_content"].includes(key)
      && typeof value === "string" && typeof merged[key] === "string") {
      merged[key] = `${merged[key]}${value}`;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function buildOpenAiChatContinuation(toolCalls: ReturnType<StreamingBlocks["toolCalls"]>, assistantFields: Record<string, unknown>): ProviderContinuationState | undefined {
  // 纯文字轮（无工具调用）也持久化思考字段：思考块随轨迹回放是通用规范（四条协议线一致，
  // 与厂商无关）；DeepSeek 携带 tools 时更是硬性要求（缺失 400）。toolCallIds 允许为空。
  if (Object.keys(assistantFields).length === 0) return undefined;
  return {
    protocol: "openai_chat",
    toolCallIds: toolCalls.map((call) => call.id),
    assistantFields,
  };
}

function parseToolCalls(value: unknown): ReturnType<StreamingBlocks["toolCalls"]> {
  if (!Array.isArray(value)) return [];
  const calls: ReturnType<StreamingBlocks["toolCalls"]> = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !isRecord(item.function) || typeof item.function.name !== "string") continue;
    calls.push({
      id: typeof item.id === "string" && item.id ? item.id : `tool_call_${index}`,
      type: "function",
      function: {
        name: item.function.name,
        arguments: typeof item.function.arguments === "string"
          ? item.function.arguments
          : JSON.stringify(item.function.arguments ?? {}),
      },
    });
  }
  return calls;
}

function accumulateToolCalls(value: unknown, blocks: StreamingBlocks): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const index = typeof entry.index === "number" ? entry.index : 0;
    // open() 同 kind 同 index 幂等，跨 chunk 增量自然续接。
    const toolCall = blocks.open({ kind: "toolCall", index, id: `tool_call_${index}`, name: "", partialJson: "" });
    if (typeof entry.id === "string" && entry.id) toolCall.id = entry.id;
    if (isRecord(entry.function)) {
      if (typeof entry.function.name === "string" && entry.function.name) toolCall.name ||= entry.function.name;
      if (typeof entry.function.arguments === "string") toolCall.partialJson += entry.function.arguments;
    }
  }
}
