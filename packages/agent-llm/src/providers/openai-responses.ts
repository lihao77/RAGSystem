/**
 * OpenAI Responses 方言：线协议走 openai SDK。无状态回放（reasoning items 带加密内容
 * 逐条原样回传）是本方言的核心语义，由 buildResponsesBody（请求侧）持有。
 */
import OpenAI from "openai";
import type { ChatMessage, ChatToolCall, LlmRequest, LlmResult, LlmStreamHandler, ProviderConfig, ProviderContinuationState, TokenUsage } from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import type { AttemptGuard } from "../transport.js";
import { StreamingBlocks } from "./internal/stream-blocks.js";
import { extractText, toResponsesContent } from "../content-parts.js";
import { compactRecord } from "../record-utils.js";
import { effectiveReasoningEffort } from "../thinking.js";
import { isRecord } from "../internal/records.js";
import { extractOpenAiUsage } from "../internal/usage.js";
import {
  consumeProviderStream,
  resolveSdkFetch,
  executeProviderOperation,
  openAiBaseURL,
  requireApiKey,
  settleAsyncIterator,
  withProviderGuards,
} from "../transport.js";

export class OpenAiResponsesAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const response = await guard.total(
          createResponsesClient(request.provider).responses.create(
            buildResponsesBody(request) as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
            guard.requestOptions(),
          ),
        );
        return parseResponse(response as unknown as Record<string, unknown>);
      }),
    );
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const stream = await guard.total(
          createResponsesClient(request.provider).responses.create(
            buildResponsesBody(request, true) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
            guard.requestOptions(),
          ),
        );
        return consumeProviderStream(onChunk, (emit) => consumeResponsesStream(stream, request, guard, emit));
      }),
    );
  }
}

function createResponsesClient(provider: ProviderConfig): OpenAI {
  const fetch = resolveSdkFetch(provider);
  return new OpenAI({
    apiKey: requireApiKey(provider),
    baseURL: openAiBaseURL(provider, "/responses"),
    maxRetries: 0,
    ...(fetch ? { fetch } : {}),
  });
}

export function buildResponsesBody(request: LlmRequest, stream = false): Record<string, unknown> {
  const instructions = request.messages
    .filter((message) => message.role === "system")
    .map((message) => extractText(message.content))
    .join("\n\n") || undefined;
  const input = request.messages.flatMap((message) => mapInputMessage(message));
  const reasoningEffort = effectiveReasoningEffort(request.provider, request.thinkingLevel);
  return {
    ...compactRecord(request.extraParams),
    model: request.model,
    input,
    instructions,
    temperature: reasoningEffort ? undefined : (request.temperature ?? undefined),
    max_output_tokens: request.maxCompletionTokens ?? undefined,
    reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
    // 无服务端存储（store:false 或跨进程回放）时，reasoning items 需带加密内容才能回放。
    include: reasoningEffort ? ["reasoning.encrypted_content"] : undefined,
    prompt_cache_key: request.provider.supports_prompt_caching !== false ? request.promptCacheKey : undefined,
    tools: request.tools?.length
      ? request.tools.map((tool) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: false,
        }))
      : undefined,
    tool_choice: request.tools?.length ? (request.toolChoice ?? "auto") : undefined,
    stream: stream ? true : undefined,
  };
}

function mapInputMessage(message: ChatMessage): Record<string, unknown>[] {
  if (message.role === "system") return [];
  if (message.role === "tool") {
    return [{ type: "function_call_output", call_id: message.tool_call_id, output: extractText(message.content) }];
  }
  const items: Record<string, unknown>[] = [];
  // OpenAI 要求自上一条用户消息以来的 reasoning items 按原样、原顺序回传，
  // 且紧挨各自轮次的 function_call：逐条消息注入自己轮次的 items，不合并、不挪位。
  const continuation = message.provider_continuation?.protocol === "openai_responses"
    ? message.provider_continuation
    : undefined;
  if (continuation) items.push(...continuation.reasoningItems);
  const content = typeof message.content === "string" ? message.content : toResponsesContent(message.content);
  if (content !== "" || !message.tool_calls?.length) {
    items.push({ type: "message", role: message.role, content });
  }
  for (const call of message.tool_calls ?? []) {
    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }
  return items;
}

function parseResponse(body: Record<string, unknown>): LlmResult {
  const content = extractOutputText(body);
  const reasoning = extractResponseReasoning(body);
  const toolCalls = extractResponseToolCalls(body);
  const reasoningItems = extractResponseReasoningItems(body);
  const finishReason = typeof body.status === "string" ? body.status : null;
  if (!content && !reasoning && toolCalls.length === 0) {
    throw new Error(`OpenAI Responses output did not include assistant content (status=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, raw: body, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (toolCalls.length) result.toolCalls = toolCalls;
  const continuation = buildResponsesContinuation(toolCalls, reasoningItems);
  if (continuation) result.providerContinuation = continuation;
  const usage = extractOpenAiUsage(body);
  if (usage) result.usage = usage;
  return result;
}

async function consumeResponsesStream(
  stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
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
  const reasoningItems = new Map<number, Record<string, unknown>>();
  const iterator = stream[Symbol.asyncIterator]();

  try {
    while (true) {
      const result = await guard.next(iterator.next());
      if (result.done) break;
      const event = result.value as unknown as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "error" || type === "response.failed") {
        throw new Error(extractErrorMessage(event) ?? extractNestedResponseError(event) ?? "OpenAI Responses stream failed");
      }
      const outputIndex = typeof event.output_index === "number" ? event.output_index : undefined;
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        content += event.delta;
        const control = await onChunk({ content: event.delta, finishReason, raw: event });
        if (control?.stop) {
          stopped = true;
          break;
        }
      } else if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
        reasoning += event.delta;
        const control = await onChunk({ content: "", reasoning: event.delta, finishReason, raw: event });
        if (control?.stop) {
          stopped = true;
          break;
        }
      } else if (type === "response.output_item.added" && isRecord(event.item)) {
        const index = outputIndex ?? blocks.toolCallBlocks().length + reasoningItems.size;
        if (event.item.type === "function_call") openResponseTool(blocks, index, event.item);
        if (event.item.type === "reasoning") reasoningItems.set(index, event.item);
      } else if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const index = outputIndex ?? 0;
        blocks.open({ kind: "toolCall", index, id: responseCallId(event, index), name: "", partialJson: "" });
        blocks.appendToolArguments(index, event.delta);
      } else if (type === "response.output_item.done" && isRecord(event.item) && event.item.type === "function_call") {
        const index = outputIndex ?? blocks.toolCallBlocks().length;
        openResponseTool(blocks, index, event.item);
      } else if (type === "response.output_item.done" && isRecord(event.item) && event.item.type === "reasoning") {
        const index = outputIndex ?? reasoningItems.size;
        reasoningItems.set(index, event.item);
      }
      if (type === "response.completed" || type === "response.incomplete") {
        if (isRecord(event.response)) {
          finishReason = typeof event.response.status === "string" ? event.response.status : type.slice("response.".length);
          usage = extractOpenAiUsage(event.response) ?? usage;
          if (!content) content = extractOutputText(event.response);
          if (!reasoning) reasoning = extractResponseReasoning(event.response);
          for (const [index, item] of extractResponseReasoningItems(event.response).entries()) {
            if (![...reasoningItems.values()].some((current) => current.id === item.id && item.id !== undefined)) {
              reasoningItems.set(reasoningItems.size + index, item);
            }
          }
          for (const [index, call] of extractResponseToolCalls(event.response).entries()) {
            if (!blocks.toolCallBlocks().some((block) => block.id === call.id)) {
              blocks.open({
                kind: "toolCall",
                index: blocks.toolCallBlocks().length + index,
                id: call.id,
                name: call.function.name,
                partialJson: call.function.arguments,
              });
            }
          }
        }
        break;
      }
    }
    guard.throwIfAborted();
  } finally {
    await settleAsyncIterator(iterator);
  }

  const toolCalls = blocks.toolCalls();
  if (toolCalls.length && !stopped) await onChunk({ content: "", finishReason, toolCalls });
  if (!content && !reasoning && !toolCalls.length && !stopped && !request.allowEmptyStream) {
    throw new Error(`OpenAI Responses streaming response did not include assistant content (status=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (toolCalls.length) result.toolCalls = toolCalls;
  const continuationItems = [...reasoningItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  const continuation = buildResponsesContinuation(toolCalls, continuationItems);
  if (continuation) result.providerContinuation = continuation;
  if (usage) result.usage = usage;
  return result;
}

function openResponseTool(blocks: StreamingBlocks, index: number, item: Record<string, unknown>): void {
  const block = blocks.open({
    kind: "toolCall",
    index,
    id: typeof item.call_id === "string" && item.call_id ? item.call_id : `tool_call_${index}`,
    name: typeof item.name === "string" ? item.name : "",
    partialJson: typeof item.arguments === "string" ? item.arguments : "",
  });
  // done 事件携带定稿值（name/arguments 可能只在此时出现），非空即覆盖累积值。
  if (typeof item.call_id === "string" && item.call_id) block.id = item.call_id;
  if (typeof item.name === "string" && item.name) block.name = item.name;
  if (typeof item.arguments === "string" && item.arguments) block.partialJson = item.arguments;
}

function extractErrorMessage(body: Record<string, unknown>): string | null {
  return isRecord(body.error) && typeof body.error.message === "string" ? body.error.message : null;
}

function extractOutputText(body: unknown): string {
  if (!isRecord(body)) return "";
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) return "";
  return body.output.flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.content)) return [];
    return item.content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "");
  }).join("");
}

function extractResponseReasoning(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.output)) return "";
  return body.output.flatMap((item) => {
    if (!isRecord(item) || item.type !== "reasoning" || !Array.isArray(item.summary)) return [];
    return item.summary.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "");
  }).join("");
}

function extractResponseReasoningItems(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.output)) return [];
  return body.output.filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "reasoning");
}

function buildResponsesContinuation(
  toolCalls: ChatToolCall[],
  newItems: Record<string, unknown>[],
): Extract<ProviderContinuationState, { protocol: "openai_responses" }> | null {
  // 纯文字轮（无 function call）的 reasoning items 同样落库：无状态模式下官方支持跨轮回放。
  if (!newItems.length) return null;
  return {
    protocol: "openai_responses",
    toolCallIds: toolCalls.map((call) => call.id),
    ...(toolCalls.length ? { anchorCallId: toolCalls[0]!.id } : {}),
    reasoningItems: newItems,
  };
}

function extractResponseToolCalls(body: unknown): ChatToolCall[] {
  if (!isRecord(body) || !Array.isArray(body.output)) return [];
  return body.output.flatMap((item, index) => {
    if (!isRecord(item) || item.type !== "function_call" || typeof item.name !== "string") return [];
    return [{
      id: typeof item.call_id === "string" && item.call_id ? item.call_id : `tool_call_${index}`,
      type: "function" as const,
      function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
    }];
  });
}

function responseCallId(body: Record<string, unknown>, index: number): string {
  return typeof body.call_id === "string" && body.call_id ? body.call_id : `tool_call_${index}`;
}

function extractNestedResponseError(body: Record<string, unknown>): string | null {
  return isRecord(body.response) && isRecord(body.response.error) && typeof body.response.error.message === "string"
    ? body.response.error.message
    : null;
}
