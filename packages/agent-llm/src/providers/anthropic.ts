import type {
  ChatMessage,
  ChatToolCall,
  LlmRequest,
  LlmResult,
  LlmStreamHandler,
  ReasoningBlock,
} from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import { extractText, toAnthropicContent } from "../content-parts.js";
import { compactRecord } from "../record-utils.js";
import { isRecord } from "../internal/records.js";
import { extractAnthropicUsage } from "../internal/usage.js";
import { readSse } from "../internal/sse.js";
import {
  anthropicHeaders,
  extractErrorMessage,
  fetchProvider,
  providerTimeoutMs,
  readProviderStream,
  requestInit,
  requireApiKey,
  requireOkJson,
  resolveEndpoint,
} from "../transport.js";

type CacheControl = { type: "ephemeral" };
type CacheableTextBlock = { type: "text"; text: string; cache_control?: CacheControl };
type CacheableTool = {
  name: string;
  description: string | undefined;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
};
type ToolAccumulator = { id: string; name: string; arguments: string };
type ThinkingAccumulator = { type: "thinking"; thinking: string; signature: string };

export class AnthropicAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    const response = await this.fetch(request, false);
    return parseAnthropicResponse(await requireOkJson(response, request));
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    const response = await this.fetch(request, true);
    if (!response.ok) {
      await requireOkJson(response, request);
    }
    return readProviderStream(request, response, () => parseAnthropicStream(response, request, onChunk));
  }

  private fetch(request: LlmRequest, stream: boolean): Promise<Response> {
    const apiKey = requireApiKey(request.provider);
    return fetchProvider(
      request,
      resolveEndpoint(request.provider, "anthropic"),
      requestInit(request, anthropicHeaders(apiKey), buildAnthropicBody(request, stream)),
    );
  }
}

export function buildAnthropicBody(request: LlmRequest, stream = false): Record<string, unknown> {
  const cacheEnabled = request.provider.supports_prompt_caching !== false;
  const system: CacheableTextBlock[] = request.messages
    .filter((message) => message.role === "system")
    .map((message) => ({ type: "text", text: extractText(message.content) }));
  if (cacheEnabled && system.length) system[system.length - 1]!.cache_control = { type: "ephemeral" };

  const activeContinuationIndex = findLastContinuationIndex(request.messages, "anthropic_messages");
  const messages = coalesceConsecutiveUserMessages(
    request.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role !== "system")
      .map(({ message, index }) => mapAnthropicMessage(message, index === activeContinuationIndex)),
  );
  if (cacheEnabled) markLastAssistantCacheBreakpoint(messages);

  const tools: CacheableTool[] | undefined = request.tools?.length
    ? request.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }))
    : undefined;
  if (cacheEnabled && tools?.length) tools[tools.length - 1]!.cache_control = { type: "ephemeral" };

  const budget = request.provider.thinking_budget_tokens;
  const thinking = typeof budget === "number" && Number.isFinite(budget) && budget > 0
    ? { type: "enabled", budget_tokens: Math.floor(budget) }
    : undefined;
  return {
    ...compactRecord(request.extraParams),
    model: request.model,
    messages,
    system: system.length ? system : undefined,
    temperature: thinking ? undefined : (request.temperature ?? undefined),
    max_tokens: request.maxCompletionTokens ?? request.provider.max_completion_tokens ?? request.provider.max_tokens ?? 4096,
    tools,
    tool_choice: request.tools?.length ? mapAnthropicToolChoice(request.toolChoice) : undefined,
    ...(thinking ? { thinking } : {}),
    stream: stream ? true : undefined,
  };
}

function mapAnthropicMessage(message: ChatMessage, includeContinuation: boolean): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: extractText(message.content) }],
    };
  }
  const role = message.role === "assistant" ? "assistant" : "user";
  const content: unknown[] = [];
  if (role === "assistant" && includeContinuation) {
    const continuationBlocks = message.provider_continuation?.protocol === "anthropic_messages"
      ? message.provider_continuation.blocks
      : message.reasoning_blocks;
    content.push(...sanitizeReasoningBlocks(continuationBlocks));
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

function findLastContinuationIndex(messages: ChatMessage[], protocol: "anthropic_messages"): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.provider_continuation?.protocol === protocol || message?.reasoning_blocks?.length) return index;
  }
  return -1;
}

function sanitizeReasoningBlocks(blocks: ReasoningBlock[] | undefined): ReasoningBlock[] {
  if (!blocks) return [];
  const output: ReasoningBlock[] = [];
  for (const block of blocks) {
    if (block.type === "thinking" && block.signature) output.push({ ...block });
    if (block.type === "redacted_thinking" && block.data) output.push({ ...block });
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

function markLastAssistantCacheBreakpoint(messages: Record<string, unknown>[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const blocks = asArray(message.content);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (!isRecord(block)) continue;
      if (block.type === "tool_use" || (block.type === "text" && block.text !== "")) {
        block.cache_control = { type: "ephemeral" };
        return;
      }
    }
  }
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
  if (reasoningBlocks.length && toolCalls.length) {
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

async function parseAnthropicStream(
  response: Response,
  request: LlmRequest,
  onChunk: LlmStreamHandler,
): Promise<LlmResult> {
  let content = "";
  let finishReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsage = false;
  let stopped = false;
  const tools = new Map<number, ToolAccumulator>();
  const completedTools: ChatToolCall[] = [];
  const thinking = new Map<number, ThinkingAccumulator>();
  const reasoningBlocks: ReasoningBlock[] = [];

  const finishTool = async (index: number): Promise<void> => {
    const tool = tools.get(index);
    if (!tool?.name) return;
    tools.delete(index);
    const call: ChatToolCall = { id: tool.id, type: "function", function: { name: tool.name, arguments: tool.arguments } };
    completedTools.push(call);
    if (!stopped) await onChunk({ content: "", finishReason, toolCalls: [call] });
  };
  const finishThinking = (index: number): void => {
    const block = thinking.get(index);
    if (!block) return;
    thinking.delete(index);
    if (block.signature) reasoningBlocks.push(block);
  };

  await readSse(response, providerTimeoutMs(request), async (event) => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      throw new Error(`Anthropic stream returned invalid JSON: ${event.data.slice(0, 160)}`);
    }
    const type = typeof body.type === "string" ? body.type : event.event;
    if (type === "error") throw new Error(extractErrorMessage(body) ?? "Anthropic stream returned an error event");
    if (type === "message_start" && isRecord(body.message)) {
      const usage = extractAnthropicUsage(body.message);
      if (usage) {
        inputTokens = usage.inputTokens;
        outputTokens = usage.outputTokens;
        hasUsage = true;
      }
    } else if (type === "content_block_start") {
      const index = numericIndex(body.index);
      const block = isRecord(body.content_block) ? body.content_block : null;
      if (block?.type === "tool_use") {
        tools.set(index, {
          id: typeof block.id === "string" && block.id ? block.id : `tool_call_${index}`,
          name: typeof block.name === "string" ? block.name : "",
          arguments: typeof block.input === "string" ? block.input : "",
        });
      } else if (block?.type === "thinking") {
        thinking.set(index, {
          type: "thinking",
          thinking: typeof block.thinking === "string" ? block.thinking : "",
          signature: typeof block.signature === "string" ? block.signature : "",
        });
      } else if (block?.type === "redacted_thinking" && typeof block.data === "string") {
        reasoningBlocks.push({ type: "redacted_thinking", data: block.data });
      } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
        content += block.text;
        const control = await onChunk({ content: block.text, finishReason, raw: body });
        if (control?.stop) {
          stopped = true;
          return true;
        }
      }
    } else if (type === "content_block_delta" && isRecord(body.delta)) {
      const index = numericIndex(body.index);
      if (body.delta.type === "text_delta" && typeof body.delta.text === "string") {
        content += body.delta.text;
        const control = await onChunk({ content: body.delta.text, finishReason, raw: body });
        if (control?.stop) {
          stopped = true;
          return true;
        }
      } else if (body.delta.type === "input_json_delta" && typeof body.delta.partial_json === "string") {
        const tool = tools.get(index);
        if (tool) tool.arguments += body.delta.partial_json;
      } else if (body.delta.type === "thinking_delta" && typeof body.delta.thinking === "string") {
        const block = thinking.get(index) ?? { type: "thinking", thinking: "", signature: "" };
        block.thinking += body.delta.thinking;
        thinking.set(index, block);
      } else if (body.delta.type === "signature_delta" && typeof body.delta.signature === "string") {
        const block = thinking.get(index) ?? { type: "thinking", thinking: "", signature: "" };
        block.signature += body.delta.signature;
        thinking.set(index, block);
      }
    } else if (type === "content_block_stop") {
      const index = numericIndex(body.index);
      finishThinking(index);
      await finishTool(index);
    } else if (type === "message_delta") {
      if (isRecord(body.delta) && typeof body.delta.stop_reason === "string") finishReason = body.delta.stop_reason;
      const usage = extractAnthropicUsage(body);
      if (usage) {
        outputTokens = usage.outputTokens;
        hasUsage = true;
      }
    } else if (type === "message_stop") {
      return true;
    }
    return false;
  }, request.signal);

  for (const index of [...thinking.keys()].sort((a, b) => a - b)) finishThinking(index);
  for (const index of [...tools.keys()].sort((a, b) => a - b)) await finishTool(index);
  const reasoning = reasoningBlocks.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join("");
  if (!content && !reasoningBlocks.length && !completedTools.length && finishReason !== "interrupted" && !stopped && !request.allowEmptyStream) {
    throw new Error(`Anthropic streaming response did not include assistant content (stopReason=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (reasoningBlocks.length) result.reasoningBlocks = reasoningBlocks;
  if (completedTools.length) result.toolCalls = completedTools;
  if (reasoningBlocks.length && completedTools.length) {
    result.providerContinuation = {
      protocol: "anthropic_messages",
      toolCallIds: completedTools.map((call) => call.id),
      blocks: reasoningBlocks,
    };
  }
  if (hasUsage) result.usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
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
