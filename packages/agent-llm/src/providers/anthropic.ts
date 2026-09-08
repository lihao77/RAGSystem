/**
 * Anthropic Messages 方言：线协议走 @anthropic-ai/sdk。缓存断点布局与 thinking
 * 块原样回放是本方言的核心语义，由 buildAnthropicBody（请求侧）与流式块模型（响应侧）持有。
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ChatToolCall,
  LlmRequest,
  LlmResult,
  LlmStreamHandler,
  ReasoningBlock,
} from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import type { AttemptGuard } from "../transport.js";
import { StreamingBlocks } from "./internal/stream-blocks.js";
import { extractText, toAnthropicContent } from "../content-parts.js";
import { compactRecord } from "../record-utils.js";
import { effectiveReasoningEffort, effectiveThinkingBudget } from "../thinking.js";
import { isRecord } from "../internal/records.js";
import { extractAnthropicUsage } from "../internal/usage.js";
import { resolveProviderHeaders } from "../provider-headers.js";
import {
  anthropicBaseURL,
  consumeProviderStream,
  resolveSdkFetch,
  executeProviderOperation,
  requireApiKey,
  settleAsyncIterator,
  withProviderGuards,
} from "../transport.js";

type CacheControl = { type: "ephemeral" };
type CacheableTextBlock = { type: "text"; text: string; cache_control?: CacheControl };
type CacheableTool = {
  name: string;
  description: string | undefined;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
};

export class AnthropicAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const message = await guard.total(
          createMessagesClient(request).messages.create(
            buildAnthropicBody(request) as unknown as Anthropic.MessageCreateParamsNonStreaming,
            guard.requestOptions(),
          ),
        );
        return parseAnthropicResponse(message as unknown as Record<string, unknown>);
      }),
    );
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const stream = await guard.total(
          createMessagesClient(request).messages.create(
            buildAnthropicBody(request, true) as unknown as Anthropic.MessageCreateParamsStreaming,
            guard.requestOptions(),
          ),
        );
        return consumeProviderStream(onChunk, (emit) => consumeAnthropicStream(stream, request, guard, emit));
      }),
    );
  }
}

/** 按请求构造（pi-ai 同款 createClient 模式）；重试/超时归策略层。 */
function createMessagesClient(request: LlmRequest): Anthropic {
  const provider = request.provider;
  const fetch = resolveSdkFetch(provider);
  const headers = resolveProviderHeaders(provider, request.promptCacheKey);
  return new Anthropic({
    apiKey: requireApiKey(provider),
    baseURL: anthropicBaseURL(provider),
    maxRetries: 0,
    ...(headers ? { defaultHeaders: headers } : {}),
    ...(fetch ? { fetch } : {}),
  });
}

export function buildAnthropicBody(request: LlmRequest, stream = false): Record<string, unknown> {
  const cacheEnabled = request.provider.supports_prompt_caching !== false;
  const system: CacheableTextBlock[] = request.messages
    .filter((message) => message.role === "system")
    .map((message) => ({ type: "text", text: extractText(message.content) }));
  if (cacheEnabled && system.length) system[system.length - 1]!.cache_control = { type: "ephemeral" };

  const messages = coalesceConsecutiveUserMessages(
    request.messages
      .filter((message) => message.role !== "system")
      .map((message) => mapAnthropicMessage(message)),
  );
  if (cacheEnabled) markLatestMessageCacheBreakpoint(messages);

  const tools: CacheableTool[] | undefined = request.tools?.length
    ? request.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }))
    : undefined;
  if (cacheEnabled && tools?.length) tools[tools.length - 1]!.cache_control = { type: "ephemeral" };

  const budget = effectiveThinkingBudget(request.provider, request.thinkingLevel);
  // effort 型 anthropic 兼容端点（模型条目声明 thinking_kind: effort——智谱/Kimi/
  // 阿里/火山等 /v1/messages 网关）：budget_tokens 被无视，档位唯一落点是 output_config.effort；
  // thinking.enabled 作通用开信号（adaptive 仅部分端点认）。off 与无档位不发字段——多数
  // 该类模型思考强制开启，关闭语义无处落点，降级为模型默认。
  const effort = effectiveReasoningEffort(request.provider, request.thinkingLevel);
  const effortLevel = effort !== undefined && effort !== "none" ? effort : undefined;
  const budgetTokens = typeof budget === "number" && Number.isFinite(budget) && budget > 0
    ? Math.floor(budget)
    : undefined;
  const thinkingOn = effortLevel !== undefined || budgetTokens !== undefined;
  const configuredMaxTokens = request.maxCompletionTokens ?? request.provider.max_completion_tokens ?? request.provider.max_tokens;
  let maxTokens = configuredMaxTokens ?? 4096;
  let thinkingBudget = budgetTokens;
  if (thinkingBudget != null) {
    if (configuredMaxTokens == null) {
      // Anthropic 要求 budget_tokens 严格小于 max_tokens：默认上限不足以容纳档位预算时抬高。
      maxTokens = Math.max(maxTokens, thinkingBudget + 1024);
    } else {
      thinkingBudget = Math.min(thinkingBudget, maxTokens - 1);
    }
  }
  return {
    ...compactRecord(request.extraParams),
    model: request.model,
    messages,
    system: system.length ? system : undefined,
    temperature: thinkingOn ? undefined : (request.temperature ?? undefined),
    max_tokens: maxTokens,
    tools,
    tool_choice: request.tools?.length ? mapAnthropicToolChoice(request.toolChoice) : undefined,
    ...(thinkingOn
      ? { thinking: thinkingBudget != null ? { type: "enabled", budget_tokens: thinkingBudget } : { type: "enabled" } }
      : {}),
    ...(effortLevel ? { output_config: { effort: effortLevel } } : {}),
    stream: stream ? true : undefined,
  };
}

function mapAnthropicMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: extractText(message.content) }],
    };
  }
  const role = message.role === "assistant" ? "assistant" : "user";
  const content: unknown[] = [];
  if (role === "assistant") {
    // 工具事务内每条 assistant 的 thinking 块必须随自己的 tool_use 原样回传（Anthropic 硬性要求，
    // "Pass every thinking block back ... alongside the tool_use block it accompanied"）。
    // 事务外的历史消息不带这些字段，天然不回传；跨 turn 丢弃 prior thinking 是官方允许的姿势。
    const continuationBlocks = message.provider_continuation?.protocol === "anthropic_messages"
      ? message.provider_continuation.blocks
      : message.reasoning_blocks;
    content.push(...renderReasoningBlocks(continuationBlocks));
  }
  if (message.content) content.push(...toAnthropicContent(message.content));
  else if (!message.tool_calls?.length && content.length === 0) content.push({ type: "text", text: "" });
  for (const toolCall of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseArguments(toolCall.function.arguments),
    });
  }
  return { role, content };
}

/**
 * 隐藏推理块 → wire 内容块。
 * 带签名的 thinking / redacted_thinking 原样回传（签名校验要求）；
 * 空签名 thinking（如中断的流式响应）不能作为 thinking 块下发——官方会拒——
 * 有正文的降级为普通 text 块保留信息，空块丢弃。
 */
function renderReasoningBlocks(blocks: ReasoningBlock[] | undefined): unknown[] {
  const output: unknown[] = [];
  for (const block of blocks ?? []) {
    if (block.type === "redacted_thinking" && block.data) {
      output.push({ type: "redacted_thinking", data: block.data });
    } else if (block.type === "thinking") {
      if (block.signature) {
        output.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      } else if (block.thinking.trim()) {
        // 降级为正文的思考统一用 <think> 包裹，与跨模型投影一致，避免与回答正文混淆。
        output.push({ type: "text", text: `<think>${block.thinking}</think>` });
      }
    }
  }
  return output;
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function coalesceConsecutiveUserMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const message of messages) {
    const previous = output[output.length - 1];
    if (previous?.role === "user" && message.role === "user") {
      previous.content = [...asArray(previous.content), ...asArray(message.content)];
    } else {
      output.push(message);
    }
  }
  return output;
}

function markLatestMessageCacheBreakpoint(messages: Record<string, unknown>[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const blocks = asArray(message.content);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (!isRecord(block)) continue;
      if (isCacheableMessageBlock(block)) {
        block.cache_control = { type: "ephemeral" };
        return;
      }
    }
  }
}

function isCacheableMessageBlock(block: Record<string, unknown>): boolean {
  if (block.type === "tool_result" || block.type === "tool_use" || block.type === "image") return true;
  return block.type === "text" && typeof block.text === "string" && block.text.length > 0;
}

function mapAnthropicToolChoice(choice: "auto" | "none" | undefined): Record<string, unknown> {
  return choice === "none" ? { type: "none" } : { type: "auto" };
}

function parseAnthropicResponse(body: Record<string, unknown>): LlmResult {
  const content = extractAnthropicText(body);
  const reasoningBlocks = extractReasoningBlocks(body);
  const reasoning = reasoningBlocks.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join("");
  const toolCalls = extractAnthropicToolCalls(body);
  const finishReason = typeof body.stop_reason === "string" ? body.stop_reason : null;
  if (!content && !reasoningBlocks.length && !toolCalls.length) {
    throw new Error(`Anthropic response did not include assistant content (stopReason=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, raw: body, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (reasoningBlocks.length) result.reasoningBlocks = reasoningBlocks;
  if (toolCalls.length) result.toolCalls = toolCalls;
  // 纯文字轮（无工具调用）的 thinking 同样落库：新模型保留全部历史思考，旧模型由 API 自动剥离。
  if (reasoningBlocks.length) {
    result.providerContinuation = {
      protocol: "anthropic_messages",
      toolCallIds: toolCalls.map((call) => call.id),
      blocks: reasoningBlocks,
    };
  }
  const usage = extractAnthropicUsage(body);
  if (usage) result.usage = usage;
  return result;
}

async function consumeAnthropicStream(
  stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  request: LlmRequest,
  guard: AttemptGuard,
  onChunk: LlmStreamHandler,
): Promise<LlmResult> {
  let finishReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens: number | null = null;
  let cacheCreationInputTokens: number | null = null;
  let hasUsage = false;
  let stopped = false;
  const blocks = new StreamingBlocks();
  // redacted_thinking 是终块（无 delta），按出现 index 与 thinking 块合并排序回放。
  const redacted: { index: number; block: ReasoningBlock }[] = [];
  const completedTools: ChatToolCall[] = [];
  const iterator = stream[Symbol.asyncIterator]();

  const finishTool = async (index: number): Promise<void> => {
    const block = blocks.find(index);
    if (block?.kind !== "toolCall" || !block.name) return;
    const call = { id: block.id, type: "function" as const, function: { name: block.name, arguments: block.partialJson } };
    completedTools.push(call);
    if (!stopped) await onChunk({ content: "", finishReason, toolCalls: [call] });
  };

  try {
    while (true) {
      const result = await guard.next(iterator.next());
      if (result.done) break;
      const event = result.value as unknown as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "message_start" && isRecord(event.message)) {
        // usage 在 message_start 落底：即使流早退也保有输入侧计数（pi-ai 同款容错）。
        const usage = extractAnthropicUsage(event.message);
        if (usage) {
          inputTokens = usage.inputTokens;
          outputTokens = usage.outputTokens;
          cachedInputTokens = usage.cachedInputTokens ?? cachedInputTokens;
          cacheCreationInputTokens = usage.cacheCreationInputTokens ?? cacheCreationInputTokens;
          hasUsage = true;
        }
      } else if (type === "content_block_start") {
        const index = numericIndex(event.index);
        const block = isRecord(event.content_block) ? event.content_block : null;
        if (block?.type === "tool_use") {
          blocks.open({
            kind: "toolCall",
            index,
            id: typeof block.id === "string" && block.id ? block.id : `tool_call_${index}`,
            name: typeof block.name === "string" ? block.name : "",
            partialJson: typeof block.input === "string" ? block.input : "",
          });
        } else if (block?.type === "thinking") {
          blocks.open({
            kind: "thinking",
            index,
            thinking: typeof block.thinking === "string" ? block.thinking : "",
            signature: typeof block.signature === "string" ? block.signature : "",
          });
        } else if (block?.type === "redacted_thinking" && typeof block.data === "string") {
          redacted.push({ index, block: { type: "redacted_thinking", data: block.data } });
        } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
          blocks.appendText(index, block.text);
          const control = await onChunk({ content: block.text, finishReason, raw: event });
          if (control?.stop) {
            stopped = true;
            break;
          }
        }
      } else if (type === "content_block_delta" && isRecord(event.delta)) {
        const index = numericIndex(event.index);
        if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
          blocks.appendText(index, event.delta.text);
          const control = await onChunk({ content: event.delta.text, finishReason, raw: event });
          if (control?.stop) {
            stopped = true;
            break;
          }
        } else if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
          blocks.appendToolArguments(index, event.delta.partial_json);
        } else if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
          blocks.appendThinking(index, event.delta.thinking);
          const control = await onChunk({ content: "", reasoning: event.delta.thinking, finishReason, raw: event });
          if (control?.stop) {
            stopped = true;
            break;
          }
        } else if (event.delta.type === "signature_delta" && typeof event.delta.signature === "string") {
          blocks.appendSignature(index, event.delta.signature);
        }
      } else if (type === "content_block_stop") {
        const index = numericIndex(event.index);
        await finishTool(index);
      } else if (type === "message_delta") {
        if (isRecord(event.delta) && typeof event.delta.stop_reason === "string") finishReason = event.delta.stop_reason;
        const usage = extractAnthropicUsage(event);
        if (usage) {
          // message_delta 仅更新非空字段：部分代理不回传 input 侧（pi-ai 同款容错）。
          // 实测有网关（zhipu anthropic 兼容层）message_start 全 0、真实 input/cache
          // 只随 message_delta 到达——input 侧带值时必须采纳，否则该轮缓存进分子而
          // input 恒 0（表现为 run 级 token_in=0、会话命中率 >100%）。
          if (usage.inputTokens > 0) inputTokens = usage.inputTokens;
          outputTokens = usage.outputTokens;
          cachedInputTokens = usage.cachedInputTokens ?? cachedInputTokens;
          cacheCreationInputTokens = usage.cacheCreationInputTokens ?? cacheCreationInputTokens;
          hasUsage = true;
        }
      } else if (type === "message_stop") {
        break;
      }
    }
    guard.throwIfAborted();
  } finally {
    await settleAsyncIterator(iterator);
  }

  const content = blocks.text();
  // 流在 content_block_stop 前结束（stop 控制/对端提前收流）时补 flush 未完结工具块：
  // 结果仍携带已累积工具（旧版收尾循环语义），stopped 时不补发 chunk。
  for (const block of blocks.toolCallBlocks()) {
    if (!block.name || completedTools.some((call) => call.id === block.id)) continue;
    const call = { id: block.id, type: "function" as const, function: { name: block.name, arguments: block.partialJson } };
    completedTools.push(call);
    if (!stopped) await onChunk({ content: "", finishReason, toolCalls: [call] });
  }
  const reasoningBlocks = [...redacted, ...blocks.reasoningEntries()]
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.block);
  const reasoning = reasoningBlocks.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join("");
  if (!content && !reasoningBlocks.length && !completedTools.length && finishReason !== "interrupted" && !stopped && !request.allowEmptyStream) {
    throw new Error(`Anthropic streaming response did not include assistant content (stopReason=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (reasoningBlocks.length) result.reasoningBlocks = reasoningBlocks;
  if (completedTools.length) result.toolCalls = completedTools;
  // 同 parseAnthropicResponse：纯文字轮的 thinking 也要落库回放。
  if (reasoningBlocks.length) {
    result.providerContinuation = {
      protocol: "anthropic_messages",
      toolCallIds: completedTools.map((call) => call.id),
      blocks: reasoningBlocks,
    };
  }
  if (hasUsage) {
    result.usage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
      ...(cacheCreationInputTokens !== null ? { cacheCreationInputTokens } : {}),
    };
  }
  return result;
}

function extractAnthropicText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.content)) return "";
  return body.content.map((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "").join("");
}

function extractReasoningBlocks(body: unknown): ReasoningBlock[] {
  if (!isRecord(body) || !Array.isArray(body.content)) return [];
  const output: ReasoningBlock[] = [];
  for (const block of body.content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string") {
      output.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
    }
    if (block.type === "redacted_thinking" && typeof block.data === "string") {
      output.push({ type: "redacted_thinking", data: block.data });
    }
  }
  return output;
}

function extractAnthropicToolCalls(body: unknown): ChatToolCall[] {
  if (!isRecord(body) || !Array.isArray(body.content)) return [];
  return body.content.flatMap((block, index) => {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") return [];
    return [{
      id: typeof block.id === "string" && block.id ? block.id : `tool_call_${index}`,
      type: "function" as const,
      function: { name: block.name, arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}) },
    }];
  });
}

function numericIndex(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
