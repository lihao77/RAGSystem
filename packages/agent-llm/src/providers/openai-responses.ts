import type { ChatMessage, ChatToolCall, LlmRequest, LlmResult, LlmStreamHandler, ProviderContinuationState, TokenUsage } from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import { extractText, toResponsesContent } from "../content-parts.js";
import { compactRecord } from "../record-utils.js";
import { effectiveReasoningEffort } from "../thinking.js";
import { isRecord } from "../internal/records.js";
import { extractOpenAiUsage } from "../internal/usage.js";
import { readSse } from "../internal/sse.js";
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

interface ResponseToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAiResponsesAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    return this.call(request, false, async (response) => parseResponse(await requireOkJson(response, request)));
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return this.call(request, true, async (response) => {
      if (!response.ok) await requireOkJson(response, request);
      return consumeProviderStream(onChunk, (guardedOnChunk) => parseResponseStream(response, request, guardedOnChunk));
    });
  }

  private call<T>(request: LlmRequest, stream: boolean, consume: (response: Response) => Promise<T>): Promise<T> {
    const apiKey = requireApiKey(request.provider);
    return executeProviderCall(
      request,
      resolveEndpoint(request.provider, "responses"),
      requestInit(request, bearerHeaders(apiKey), buildResponsesBody(request, stream)),
      consume,
    );
  }
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

async function parseResponseStream(
  response: Response,
  request: LlmRequest,
  onChunk: LlmStreamHandler,
): Promise<LlmResult> {
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  let stopped = false;
  const tools = new Map<number, ResponseToolAccumulator>();
  const reasoningItems = new Map<number, Record<string, unknown>>();

  await readSse(response, providerTimeoutMs(request), async (event) => {
    const data = event.data.trim();
    if (data === "[DONE]") return true;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error(`OpenAI Responses stream returned invalid JSON: ${data.slice(0, 160)}`);
    }
    const type = typeof body.type === "string" ? body.type : event.event;
    if (type === "error" || type === "response.failed") {
      throw new Error(extractErrorMessage(body) ?? extractNestedResponseError(body) ?? "OpenAI Responses stream failed");
    }
    if (type === "response.output_text.delta" && typeof body.delta === "string") {
      content += body.delta;
      const control = await onChunk({ content: body.delta, finishReason, raw: body });
      if (control?.stop) {
        stopped = true;
        return true;
      }
    } else if (type === "response.reasoning_summary_text.delta" && typeof body.delta === "string") {
      reasoning += body.delta;
      const control = await onChunk({ content: "", reasoning: body.delta, finishReason, raw: body });
      if (control?.stop) {
        stopped = true;
        return true;
      }
    } else if (type === "response.output_item.added" && isRecord(body.item)) {
      const index = typeof body.output_index === "number" ? body.output_index : tools.size + reasoningItems.size;
      if (body.item.type === "function_call") tools.set(index, toolFromResponseItem(body.item, index));
      if (body.item.type === "reasoning") reasoningItems.set(index, body.item);
    } else if (type === "response.function_call_arguments.delta" && typeof body.delta === "string") {
      const index = typeof body.output_index === "number" ? body.output_index : 0;
      const current = tools.get(index) ?? { id: responseCallId(body, index), name: "", arguments: "" };
      current.arguments += body.delta;
      tools.set(index, current);
    } else if (type === "response.output_item.done" && isRecord(body.item) && body.item.type === "function_call") {
      const index = typeof body.output_index === "number" ? body.output_index : tools.size;
      const parsed = toolFromResponseItem(body.item, index);
      const current = tools.get(index);
      tools.set(index, {
        id: parsed.id || current?.id || `tool_call_${index}`,
        name: parsed.name || current?.name || "",
        arguments: parsed.arguments || current?.arguments || "",
      });
    } else if (type === "response.output_item.done" && isRecord(body.item) && body.item.type === "reasoning") {
      const index = typeof body.output_index === "number" ? body.output_index : reasoningItems.size;
      reasoningItems.set(index, body.item);
    }
    if ((type === "response.completed" || type === "response.incomplete") && isRecord(body.response)) {
      finishReason = typeof body.response.status === "string" ? body.response.status : type.slice("response.".length);
      usage = extractOpenAiUsage(body.response) ?? usage;
      if (!content) content = extractOutputText(body.response);
      if (!reasoning) reasoning = extractResponseReasoning(body.response);
      for (const [index, item] of extractResponseReasoningItems(body.response).entries()) {
        if (![...reasoningItems.values()].some((current) => current.id === item.id && item.id !== undefined)) {
          reasoningItems.set(reasoningItems.size + index, item);
        }
      }
      for (const [index, call] of extractResponseToolCalls(body.response).entries()) {
        if (![...tools.values()].some((item) => item.id === call.id)) {
          tools.set(tools.size + index, { id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
      }
      return true;
    }
    return false;
  }, request.signal);

  const toolCalls = [...tools.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, tool]) => tool.name
      ? [{ id: tool.id, type: "function" as const, function: { name: tool.name, arguments: tool.arguments } }]
      : []);
  if (toolCalls.length && !stopped) await onChunk({ content: "", finishReason, toolCalls });
  if (!content && !reasoning && !toolCalls.length && !stopped && !request.allowEmptyStream) {
    throw new Error(`OpenAI Responses stream did not include assistant content (status=${finishReason ?? "unknown"})`);
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

function toolFromResponseItem(item: Record<string, unknown>, index: number): ResponseToolAccumulator {
  return {
    id: typeof item.call_id === "string" && item.call_id ? item.call_id : `tool_call_${index}`,
    name: typeof item.name === "string" ? item.name : "",
    arguments: typeof item.arguments === "string" ? item.arguments : "",
  };
}

function responseCallId(body: Record<string, unknown>, index: number): string {
  return typeof body.call_id === "string" && body.call_id ? body.call_id : `tool_call_${index}`;
}

function extractNestedResponseError(body: Record<string, unknown>): string | null {
  return isRecord(body.response) && isRecord(body.response.error) && typeof body.response.error.message === "string"
    ? body.response.error.message
    : null;
}
