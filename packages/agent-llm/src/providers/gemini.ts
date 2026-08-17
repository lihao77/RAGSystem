import type {
  ChatMessage,
  ChatToolCall,
  LlmRequest,
  LlmResult,
  LlmStreamHandler,
  ProviderContinuationState,
  TokenUsage,
} from "../types.js";
import type { LlmProviderAdapter } from "./adapter.js";
import { extractText, parseDataUrl, toContentParts } from "../content-parts.js";
import { isRecord } from "../internal/records.js";
import { readSse } from "../internal/sse.js";
import { extractGeminiUsage } from "../internal/usage.js";
import { providerDefaultEndpoint } from "../provider-registry.js";
import { compactRecord } from "../record-utils.js";
import {
  consumeProviderStream,
  executeProviderCall,
  extractErrorMessage,
  geminiHeaders,
  providerTimeoutMs,
  requestInit,
  requireApiKey,
  requireOkJson,
} from "../transport.js";

type GeminiPart = Record<string, unknown>;
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiToolMetadata = { name: string; providerId: string | undefined };

export class GeminiAdapter implements LlmProviderAdapter {
  async complete(request: LlmRequest): Promise<LlmResult> {
    return this.call(request, false, async (response) => parseGeminiResponse(await requireOkJson(response, request)));
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return this.call(request, true, async (response) => {
      if (!response.ok) await requireOkJson(response, request);
      return consumeProviderStream(onChunk, (guardedOnChunk) => parseGeminiStream(response, request, guardedOnChunk));
    });
  }

  private call<T>(request: LlmRequest, stream: boolean, consume: (response: Response) => Promise<T>): Promise<T> {
    const apiKey = requireApiKey(request.provider);
    return executeProviderCall(
      request,
      resolveGeminiEndpoint(request, stream),
      requestInit(request, geminiHeaders(apiKey), buildGeminiBody(request)),
      consume,
    );
  }
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

export function resolveGeminiEndpoint(request: LlmRequest, stream: boolean): string {
  const configured = String(request.provider.api_endpoint ?? providerDefaultEndpoint(request.provider.provider_type)).trim();
  if (!configured) throw new Error(`Provider '${request.provider.name}' is missing api_endpoint`);
  const method = stream ? "streamGenerateContent" : "generateContent";
  const normalizedModel = request.model.replace(/^models\//, "").trim();
  if (!normalizedModel) throw new Error("Gemini model is required");
  const withoutTrailingSlash = configured.replace(/\/+$/, "");
  const methodPattern = /\/models\/[^/?]+:(?:streamGenerateContent|generateContent)(?=\?|$)/;
  const endpoint = methodPattern.test(withoutTrailingSlash)
    ? withoutTrailingSlash.replace(/:(?:streamGenerateContent|generateContent)(?=\?|$)/, `:${method}`)
    : `${withoutTrailingSlash.replace(/\/models$/, "")}/models/${encodeURIComponent(normalizedModel)}:${method}`;
  if (!stream) return endpoint;
  const url = new URL(endpoint);
  url.searchParams.set("alt", "sse");
  return url.toString();
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
  if (isRecord(body.error)) throw new Error(extractErrorMessage(body) ?? "Gemini response returned an error");
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
  if (toolCalls.length) {
    result.toolCalls = toolCalls;
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

async function parseGeminiStream(
  response: Response,
  request: LlmRequest,
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

  await readSse(response, providerTimeoutMs(request), async (event) => {
    const data = event.data.trim();
    if (!data || data === "[DONE]") return data === "[DONE]";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error(`Gemini stream returned invalid JSON: ${data.slice(0, 160)}`);
    }
    if (event.event === "error" || isRecord(body.error)) {
      throw new Error(extractErrorMessage(body) ?? "Gemini stream returned an error event");
    }
    if (isRecord(body.usageMetadata)) Object.assign(usageMetadata, body.usageMetadata);
    const candidate = firstCandidate(body);
    if (!candidate) return;
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
        continue;
      }
      content += part.text;
      const control = await onChunk({ content: part.text, finishReason, raw: body });
      if (control?.stop) {
        stopped = true;
        return true;
      }
    }
    return false;
  }, request.signal);

  const completedTools = toolCalls;
  if (completedTools.length && !stopped) await onChunk({ content: "", finishReason, toolCalls: completedTools });
  if (!content && !reasoning && !completedTools.length && !stopped && !request.allowEmptyStream) {
    throw new Error(`Gemini streaming response did not include assistant content (finishReason=${finishReason ?? "unknown"})`);
  }
  const result: LlmResult = { content, finishReason };
  if (reasoning) result.reasoning = reasoning;
  if (completedTools.length) {
    result.toolCalls = completedTools;
    result.providerContinuation = {
      protocol: "gemini_generate_content",
      toolCallIds: completedTools.map((call) => call.id),
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

export { extractGeminiUsage };
