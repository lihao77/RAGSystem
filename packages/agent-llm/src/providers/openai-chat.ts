import type { ChatToolCall, LlmRequest, LlmResult, LlmStreamHandler, TokenUsage } from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import { compactRecord } from "../record-utils.js";
import { isRecord } from "../internal/records.js";
import { extractOpenAiUsage } from "../internal/usage.js";
import { readSse } from "../internal/sse.js";
import {
  bearerHeaders,
  extractErrorMessage,
  fetchProvider,
  providerTimeoutMs,
  readProviderStream,
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
    const response = await this.fetch(request, false);
    const body = await requireOkJson(response, request);
    return parseCompletion(body);
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    const response = await this.fetch(request, true);
    if (!response.ok) {
      const body = await requireOkJson(response, request);
      throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
    }
    return readProviderStream(request, response, () => parseStream(response, request, onChunk));
  }

  private fetch(request: LlmRequest, stream: boolean): Promise<Response> {
    const endpoint = resolveEndpoint(request.provider, "chat");
    const apiKey = requireApiKey(request.provider);
    return fetchProvider(
      request,
      endpoint,
      requestInit(request, bearerHeaders(apiKey), buildChatBody(request, stream)),
    );
  }
}

export function buildChatBody(request: LlmRequest, stream = false): Record<string, unknown> {
  const reasoningEffort = request.provider.reasoning_effort;
  const usesModernTokenField = request.provider.provider_type === "openai_chat" && Boolean(reasoningEffort);
  return {
    ...compactRecord(request.extraParams),
    model: request.model,
    messages: request.messages.map(stripInternalMessageFields),
    temperature: request.temperature ?? undefined,
    ...(usesModernTokenField
      ? { max_completion_tokens: request.maxCompletionTokens ?? undefined }
      : { max_tokens: request.maxCompletionTokens ?? undefined }),
    reasoning_effort: reasoningEffort ?? undefined,
    tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
    tool_choice: request.tools && request.tools.length > 0 ? (request.toolChoice ?? "auto") : undefined,
    stream: stream ? true : undefined,
    stream_options: stream ? { include_usage: true } : undefined,
  };
}

function stripInternalMessageFields(message: LlmRequest["messages"][number]): Record<string, unknown> {
  const {
    reasoning_blocks: _reasoningBlocks,
    provider_continuation: _providerContinuation,
    ...wireMessage
  } = message;
  return wireMessage;
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
  });

  const toolCalls = collectToolCalls(tools);
  if (toolCalls.length > 0 && !stopped) await onChunk({ content: "", finishReason, toolCalls });
  if (!content && !reasoning && toolCalls.length === 0 && finishReason !== "interrupted" && !stopped && !request.allowEmptyStream) {
    throw new Error(`LLM streaming response did not include assistant content (finishReason=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
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
