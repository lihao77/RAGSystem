/**
 * Google Gemini 方言：线协议走 @google/genai。candidate parts 原样回放（含
 * thoughtSignature）是本方言的核心语义；genai 对 config 未知字段会丢弃，厂商扩展
 * 经 httpOptions.extraBody 深合并兜底透传。
 */
import { GoogleGenAI } from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
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
  executeProviderOperation,
  geminiBaseURL,
  requireApiKey,
  settleAsyncIterator,
  withProviderGuards,
} from "../transport.js";

type GeminiPart = Record<string, unknown>;
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiToolMetadata = { name: string; providerId: string | undefined };

/** GenerateContentConfig 已知字段（可直下 config）；其余厂商扩展进 extraBody 深合并。
 * 注意 labels/routingConfig 不列于此：genai 的 MLdev 转换器会丢弃这两键（仅 Vertex 生效），
 * 走 extraBody 透传才能到达自定义网关。 */
const GEMINI_CONFIG_KEYS = new Set([
  "systemInstruction", "tools", "toolConfig", "temperature", "topP", "topK", "maxOutputTokens",
  "candidateCount", "stopSequences", "responseMimeType", "responseSchema", "responseJsonSchema",
  "safetySettings", "thinkingConfig", "cachedContent", "responseModalities",
  "mediaResolution", "audioTimestamp", "speechConfig", "imageConfig",
]);

export class GeminiAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const response = await guard.total(
          createGeminiClient(request).models.generateContent(generateContentParameters(request, guard)),
        );
        return parseGeminiResponse(response as unknown as Record<string, unknown>);
      }),
    );
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return executeProviderOperation(request, ({ signal }) =>
      withProviderGuards(request, signal, async (guard) => {
        const generator = await guard.total(
          createGeminiClient(request).models.generateContentStream(generateContentParameters(request, guard)),
        );
        return consumeProviderStream(onChunk, (emit) => consumeGeminiStream(generator, request, guard, emit));
      }),
    );
  }
}

/** 按请求构造；baseUrl 含版本段 + apiVersion:""（pi-ai 同款姿势，防版本段翻倍）。
 * headers 走客户端级 httpOptions——genai 的 patchHttpOptions 与请求级 extraBody 逐键合并不互覆。 */
function createGeminiClient(request: LlmRequest): GoogleGenAI {
  const provider = request.provider;
  if (provider.transport?.type === "ipc_socket") {
    // @google/genai 无 fetch 注入口，本地组网传输不适用于本方言（openai/anthropic 支持）。
    throw new Error(`Provider '${provider.name}' does not support the ipc_socket transport`);
  }
  const headers = resolveProviderHeaders(provider, request.promptCacheKey);
  return new GoogleGenAI({
    apiKey: requireApiKey(provider),
    httpOptions: { baseUrl: geminiBaseURL(provider), apiVersion: "", ...(headers ? { headers } : {}) },
  });
}

function generateContentParameters(request: LlmRequest, guard: AttemptGuard): GenerateContentParameters {
  const body = buildGeminiBody(request);
  const normalizedModel = request.model.replace(/^models\//, "").trim();
  if (!normalizedModel) throw new Error("Gemini model is required");
  const config = toGeminiConfig(body, guard.signal);
  return { model: normalizedModel, contents: body.contents, config } as unknown as GenerateContentParameters;
}

/** wire body（v1beta REST 形状，buildGeminiBody 产出）→ genai config：已知字段直下，未知进 extraBody。 */
function toGeminiConfig(body: Record<string, unknown>, signal: AbortSignal): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const extraBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "contents") continue;
    if (key === "generationConfig") {
      const generationConfig = isRecord(value) ? value : {};
      const generationExtras: Record<string, unknown> = {};
      for (const [genKey, genValue] of Object.entries(generationConfig)) {
        if (GEMINI_CONFIG_KEYS.has(genKey)) config[genKey] = genValue;
        else generationExtras[genKey] = genValue;
      }
      if (Object.keys(generationExtras).length) extraBody.generationConfig = generationExtras;
      continue;
    }
    if (GEMINI_CONFIG_KEYS.has(key)) config[key] = value;
    else extraBody[key] = value;
  }
  if (Object.keys(extraBody).length) config.httpOptions = { extraBody };
  config.abortSignal = signal;
  return config;
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
  generator: AsyncIterable<unknown>,
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
  const iterator = generator[Symbol.asyncIterator]();

  try {
    while (true) {
      const result = await guard.next(iterator.next());
      if (result.done) break;
      const chunk = result.value as Record<string, unknown>;
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
