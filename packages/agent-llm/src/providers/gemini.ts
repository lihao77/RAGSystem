/**
 * Google Gemini 方言：线级传输走 provider-utils 直连（wire.ts），buildGeminiBody 的
 * v1beta REST 形状原样即线体。candidate parts 原样回放（含 thoughtSignature）是本
 * 方言的核心语义。
 */
import type {
  ChatMessage,
  ChatToolCall,
  LlmRequest,
  LlmResult,
  LlmStreamHandler,
  ProviderContinuationState,
} from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import type { AttemptGuard } from "../transport.js";
import { extractText, parseDataUrl, toContentParts } from "../content-parts.js";
import { isRecord } from "../internal/records.js";
import { extractGeminiUsage } from "../internal/usage.js";
import { compactRecord } from "../record-utils.js";
import { resolveProviderHeaders } from "../provider-headers.js";
import {
  consumeProviderStream,
  resolveSdkFetch,
  executeProviderOperation,
  geminiBaseURL,
  requireApiKey,
  settleAsyncIterator,
  withProviderGuards,
} from "../transport.js";
import { postWireJson, postWireSse, type WireCallOptions, type WireEventStream } from "./wire.js";

type GeminiPart = Record<string, unknown>;
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiToolMetadata = { name: string; providerId: string | undefined };

export class GeminiAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const response = await guard.total(
          postWireJson(buildWireOptions(request, guard, buildGeminiBody(request), false)),
        );
        return parseGeminiResponse(response);
      }),
    );
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const events = await guard.total(
          postWireSse(buildWireOptions(request, guard, buildGeminiBody(request), true)),
        );
        return consumeProviderStream(onChunk, (emit) => consumeGeminiStream(events, request, guard, emit));
      }),
    );
  }
}

/** 线级调用参数：按请求构造；重试/超时归策略层。ipc_socket 经线层 fetch 注入支持（与 openai/anthropic 一致）。 */
function buildWireOptions(
  request: LlmRequest,
  guard: AttemptGuard,
  body: Record<string, unknown>,
  stream: boolean,
): WireCallOptions {
  const provider = request.provider;
  const normalizedModel = request.model.replace(/^models\//, "").trim();
  if (!normalizedModel) throw new Error("Gemini model is required");
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return {
    url: `${geminiBaseURL(provider)}/models/${normalizedModel}:${method}`,
    headers: {
      "x-goog-api-key": requireApiKey(provider),
      ...resolveProviderHeaders(provider, request.promptCacheKey),
    },
    body,
    signal: guard.signal,
    fetch: resolveSdkFetch(provider),
  };
}

export function buildGeminiBody(request: LlmRequest): Record<string, unknown> {
  const systemText = request.messages
    .filter((message) => message.role === "system")
    .map((message) => extractText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const toolMetadata = collectGeminiToolMetadata(request.messages);
  const contents = coalesceGeminiContents(request.messages
    .filter((message) => message.role !== "system")
    .map((message) => mapGeminiMessage(message, toolMetadata)));
  const extraParams = compactRecord(request.extraParams);
  const extraGenerationConfig = isRecord(extraParams.generationConfig) ? extraParams.generationConfig : {};
  const maxOutputTokens = request.maxCompletionTokens
    ?? request.provider.max_completion_tokens
    ?? request.provider.max_tokens
    ?? undefined;
  const generationConfig = compactRecord(extraGenerationConfig, {
    temperature: request.temperature ?? undefined,
    maxOutputTokens,
  });
  const tools = request.tools?.length
    ? [{
        functionDeclarations: request.tools.map((tool) => compactRecord({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      }]
    : undefined;
  return compactRecord(extraParams, {
    contents,
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    generationConfig: Object.keys(generationConfig).length ? generationConfig : undefined,
    tools,
    toolConfig: tools
      ? { functionCallingConfig: { mode: request.toolChoice === "none" ? "NONE" : "AUTO" } }
      : undefined,
  });
}

function mapGeminiMessage(message: ChatMessage, toolMetadata: ReadonlyMap<string, GeminiToolMetadata>): GeminiContent {
  if (message.role === "tool") {
    const callId = String(message.tool_call_id ?? "").trim();
    const metadata = toolMetadata.get(callId);
    const name = String(message.name ?? metadata?.name ?? "").trim();
    if (!name) throw new Error(`Gemini tool result '${callId || "unknown"}' is missing its function name`);
    return {
      role: "user",
      parts: [{
        functionResponse: compactRecord({
          id: metadata?.providerId ?? (metadata ? undefined : callId || undefined),
          name,
          response: parseFunctionResponse(message.content),
        }),
      }],
    };
  }
  const role = message.role === "assistant" ? "model" : "user";
  const continuation = geminiContinuation(message.provider_continuation);
  if (role === "model" && continuation) {
    return { role, parts: continuation.parts.map((part) => ({ ...part })) };
  }
  const parts = toGeminiParts(message.content);
  if (role === "model") {
    for (const call of message.tool_calls ?? []) {
      parts.push({
        functionCall: {
          id: call.id,
          name: call.function.name,
          args: parseFunctionArguments(call.function.arguments),
        },
      });
    }
  }
  return { role, parts: parts.length ? parts : [{ text: "" }] };
}

function toGeminiParts(content: ChatMessage["content"]): GeminiPart[] {
  return toContentParts(content).map((part) => {
    if (part.type === "text") return { text: part.text };
    const parsed = parseDataUrl(part.image_url.url);
    if (parsed) {
      return { inlineData: { mimeType: parsed.mediaType, data: parsed.base64 } };
    }
    return { fileData: { fileUri: part.image_url.url } };
  });
}

function collectGeminiToolMetadata(messages: ChatMessage[]): Map<string, GeminiToolMetadata> {
  const metadata = new Map<string, GeminiToolMetadata>();
  for (const message of messages) {
    const callsById = new Map((message.tool_calls ?? []).map((call) => [call.id, call]));
    const continuation = geminiContinuation(message.provider_continuation);
    if (message.role === "assistant" && continuation) {
      let functionIndex = 0;
      for (const part of continuation.parts) {
        if (!isRecord(part.functionCall)) continue;
        const callId = continuation.toolCallIds[functionIndex];
        const providerId = typeof part.functionCall.id === "string" && part.functionCall.id
          ? part.functionCall.id
          : undefined;
        const name = typeof part.functionCall.name === "string" && part.functionCall.name
          ? part.functionCall.name
          : (callId ? callsById.get(callId)?.function.name : undefined);
        if (callId && name) metadata.set(callId, { name, providerId });
        functionIndex += 1;
      }
    }
    for (const call of message.tool_calls ?? []) {
      if (!metadata.has(call.id)) metadata.set(call.id, { name: call.function.name, providerId: call.id });
    }
  }
  return metadata;
}

function coalesceGeminiContents(contents: GeminiContent[]): GeminiContent[] {
  const output: GeminiContent[] = [];
  for (const content of contents) {
    const previous = output[output.length - 1];
    if (previous?.role === content.role) previous.parts.push(...content.parts);
    else output.push(content);
  }
  return output;
}

function parseFunctionArguments(value: string): unknown {
  try {
    const parsed = JSON.parse(value || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseFunctionResponse(content: ChatMessage["content"]): Record<string, unknown> {
  const text = extractText(content);
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { result: parsed };
  } catch {
    return { result: text };
  }
}

function geminiContinuation(
  value: ChatMessage["provider_continuation"],
): Extract<ProviderContinuationState, { protocol: "gemini_generate_content" }> | null {
  return value?.protocol === "gemini_generate_content" && value.parts.length ? value : null;
}

function parseGeminiResponse(body: Record<string, unknown>): LlmResult {
  // genai 仅按 HTTP status 抛错；200 + error 体的网关在此显式报错（SDK 不会替我们检查）。
  if (isRecord(body.error)) throw new Error(extractGeminiErrorMessage(body));
  const candidate = firstCandidate(body);
  const parts = candidateParts(candidate);
  const content = visibleText(parts);
  const reasoning = thoughtText(parts);
  const toolCalls = extractGeminiToolCalls(parts);
  const finishReason = candidate && typeof candidate.finishReason === "string" ? candidate.finishReason : null;
  if (!content && !reasoning && !toolCalls.length) {
    throw new Error(`Gemini response did not include assistant content (finishReason=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, raw: body, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (toolCalls.length) result.toolCalls = toolCalls;
  // 纯文字轮也持久化 candidate parts 原样回放（含 thought/thoughtSignature 字段）。
  if (parts.length) {
    result.providerContinuation = {
      protocol: "gemini_generate_content",
      toolCallIds: toolCalls.map((call) => call.id),
      parts: parts.map((part) => ({ ...part })),
    };
  }
  const usage = extractGeminiUsage(body);
  if (usage) result.usage = usage;
  return result;
}

async function consumeGeminiStream(
  events: WireEventStream,
  request: LlmRequest,
  guard: AttemptGuard,
  onChunk: LlmStreamHandler,
): Promise<LlmResult> {
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const usageMetadata: Record<string, unknown> = {};
  let stopped = false;
  const replayParts: GeminiPart[] = [];
  const toolCalls: ChatToolCall[] = [];
  let functionCallIndex = 0;
  const iterator = events[Symbol.asyncIterator]();

  try {
    while (true) {
      const result = await guard.next(iterator.next());
      if (result.done) break;
      const chunk = result.value;
      if (isRecord(chunk.usageMetadata)) Object.assign(usageMetadata, chunk.usageMetadata);
      const candidate = firstCandidate(chunk);
      if (!candidate) continue;
      if (typeof candidate.finishReason === "string") finishReason = candidate.finishReason;
      for (const part of candidateParts(candidate)) {
        replayParts.push({ ...part });
        if (isRecord(part.functionCall)) {
          const call = extractGeminiToolCall(part, functionCallIndex);
          if (call) toolCalls.push(call);
          functionCallIndex += 1;
          continue;
        }
        if (typeof part.text !== "string") continue;
        if (part.thought === true) {
          reasoning += part.text;
          const control = await onChunk({ content: "", reasoning: part.text, finishReason, raw: chunk });
          if (control?.stop) {
            stopped = true;
            break;
          }
          continue;
        }
        content += part.text;
        const control = await onChunk({ content: part.text, finishReason, raw: chunk });
        if (control?.stop) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
    guard.throwIfAborted();
  } finally {
    await settleAsyncIterator(iterator);
  }

  if (toolCalls.length && !stopped) await onChunk({ content: "", finishReason, toolCalls });
  if (!content && !reasoning && !toolCalls.length && !stopped && !request.allowEmptyStream) {
    throw new Error(`Gemini streaming response did not include assistant content (finishReason=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (toolCalls.length) result.toolCalls = toolCalls;
  // 同 parseGeminiResponse：纯文字轮也保留 replayParts 原样回放。
  if (replayParts.length) {
    result.providerContinuation = {
      protocol: "gemini_generate_content",
      toolCallIds: toolCalls.map((call) => call.id),
      parts: replayParts,
    };
  }
  const usage = extractGeminiUsage({ usageMetadata });
  if (usage) result.usage = usage;
  return result;
}

function firstCandidate(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !Array.isArray(body.candidates) || !body.candidates.length) return null;
  return isRecord(body.candidates[0]) ? body.candidates[0] : null;
}

function candidateParts(candidate: Record<string, unknown> | null): GeminiPart[] {
  if (!candidate || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) return [];
  return candidate.content.parts.filter(isRecord);
}

function visibleText(parts: GeminiPart[]): string {
  return parts.map((part) => part.thought !== true && typeof part.text === "string" ? part.text : "").join("");
}

function thoughtText(parts: GeminiPart[]): string {
  return parts.map((part) => part.thought === true && typeof part.text === "string" ? part.text : "").join("");
}

function extractGeminiToolCalls(parts: GeminiPart[]): ChatToolCall[] {
  return parts.flatMap((part, index) => {
    const call = extractGeminiToolCall(part, index);
    return call ? [call] : [];
  });
}

function extractGeminiToolCall(part: GeminiPart, index: number): ChatToolCall | null {
  if (!isRecord(part.functionCall) || typeof part.functionCall.name !== "string") return null;
  return {
    id: typeof part.functionCall.id === "string" && part.functionCall.id
      ? part.functionCall.id
      : `gemini_call_${index}`,
    type: "function",
    function: {
      name: part.functionCall.name,
      arguments: JSON.stringify(isRecord(part.functionCall.args) ? part.functionCall.args : {}),
    },
  };
}

/** usageMetadata 提取的单一实现位于 internal/usage.ts，此处 re-export 维持历史导出路径。 */
export { extractGeminiUsage } from "../internal/usage.js";

function extractGeminiErrorMessage(body: Record<string, unknown>): string {
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return typeof body.message === "string" ? body.message : "Gemini response returned an error";
}
