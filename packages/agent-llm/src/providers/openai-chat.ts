import type { ChatToolCall, LlmRequest, LlmResult, LlmStreamHandler, ProviderContinuationState, TokenUsage } from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import { compactRecord } from "../record-utils.js";
import { buildThinkingParams } from "../thinking.js";
import { isRecord } from "../internal/records.js";
import { extractOpenAiUsage } from "../internal/usage.js";
import { readSse } from "../internal/sse.js";
import { providerTypeSpec } from "../provider-registry.js";
import {
  bearerHeaders,
  extractErrorMessage,
  consumeProviderStream,
  executeProviderCall,
  providerTimeoutMs,
  requestInit,
  requireApiKey,
  requireOkJson,
  resolveEndpoint,
} from "../transport.js";

interface ToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAiChatAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    return this.call(request, false, async (response) => parseCompletion(await requireOkJson(response, request)));
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return this.call(request, true, async (response) => {
      if (!response.ok) {
        const body = await requireOkJson(response, request);
        throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
      }
      return consumeProviderStream(onChunk, (guardedOnChunk) => parseStream(response, request, guardedOnChunk));
    });
  }

  private call<T>(request: LlmRequest, stream: boolean, consume: (response: Response) => Promise<T>): Promise<T> {
    const endpoint = resolveEndpoint(request.provider, "chat");
    const apiKey = requireApiKey(request.provider);
    return executeProviderCall(
      request,
      endpoint,
      requestInit(request, bearerHeaders(apiKey), buildChatBody(request, stream)),
      consume,
    );
  }
}

export function buildChatBody(request: LlmRequest, stream = false): Record<string, unknown> {
  const thinkingParams = buildThinkingParams(request.provider, request.thinkingLevel);
  const usesModernTokenField = request.provider.provider_type === "openai_chat" && Boolean(thinkingParams?.reasoning_effort);
  const promptCacheParams = buildPromptCacheParams(request);
  return {
    ...compactRecord(request.extraParams),
    model: request.model,
    messages: request.messages.map(stripInternalMessageFields),
    temperature: request.temperature ?? undefined,
    ...(usesModernTokenField
      ? { max_completion_tokens: request.maxCompletionTokens ?? undefined }
      : { max_tokens: request.maxCompletionTokens ?? undefined }),
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
  const params: Record<string, unknown> = {};
  if (capabilities.promptCacheMode === "explicit_blocks") {
    params.cache_control = { type: "ephemeral" };
  }
  if (capabilities.supportsPromptCacheKey && request.promptCacheKey) {
    const isOpenRouter = capabilities.promptCacheMode === "explicit_blocks";
    if (isOpenRouter || supportsOpenAiPromptCacheKey(request)) params.prompt_cache_key = request.promptCacheKey;
  }
  return params;
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
  const usage = extractOpenAiUsage(body);
  if (usage) result.usage = usage;
  return result;
}

async function parseStream(response: Response, request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  let stopped = false;
  const tools = new Map<number, ToolAccumulator>();
  const assistantFields: Record<string, unknown> = {};

  await readSse(response, providerTimeoutMs(request), async (event) => {
    const data = event.data.trim();
    if (data === "[DONE]") return true;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error(`LLM stream returned invalid JSON: ${data.slice(0, 160)}`);
    }
    if (event.event === "error" || body.type === "error") {
      throw new Error(extractErrorMessage(body) ?? "LLM stream returned an error event");
    }
    usage = extractOpenAiUsage(body) ?? usage;
    const choice = firstChoice(body);
    if (!choice) return;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = isRecord(choice.delta) ? choice.delta : choice;
    accumulateToolCalls(delta.tool_calls, tools);
    accumulateOpenAiChatAssistantFields(delta, assistantFields);
    reasoning += extractReasoning(delta);
    const text = extractTextContent(delta.content) || extractTextContent(choice.text);
    if (text) {
      content += text;
      const control = await onChunk({ content: text, finishReason, raw: body });
      if (control?.stop) {
        stopped = true;
        return true;
      }
    }
    return finishReason === "interrupted";
  }, request.signal);

  const toolCalls = collectToolCalls(tools);
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

function buildOpenAiChatContinuation(toolCalls: ChatToolCall[], assistantFields: Record<string, unknown>): ProviderContinuationState | undefined {
  if (toolCalls.length === 0 || Object.keys(assistantFields).length === 0) return undefined;
  return {
    protocol: "openai_chat",
    toolCallIds: toolCalls.map((call) => call.id),
    assistantFields,
  };
}

function parseToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];
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

function accumulateToolCalls(value: unknown, accumulators: Map<number, ToolAccumulator>): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const index = typeof entry.index === "number" ? entry.index : 0;
    const current = accumulators.get(index) ?? { id: `tool_call_${index}`, name: "", arguments: "" };
    if (typeof entry.id === "string" && entry.id) current.id = entry.id;
    if (isRecord(entry.function)) {
      if (typeof entry.function.name === "string" && entry.function.name) current.name ||= entry.function.name;
      if (typeof entry.function.arguments === "string") current.arguments += entry.function.arguments;
    }
    accumulators.set(index, current);
  }
}

function collectToolCalls(accumulators: Map<number, ToolAccumulator>): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  for (const index of [...accumulators.keys()].sort((a, b) => a - b)) {
    const item = accumulators.get(index);
    if (item?.name) calls.push({ id: item.id, type: "function", function: { name: item.name, arguments: item.arguments } });
  }
  return calls;
}
