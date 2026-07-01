/**
 * OpenAiCompatibleClient —— OpenAI/Anthropic 兼容的 LLM 客户端（基金层默认实现）。
 *
 * 三条分派路径：openai_resp（Responses API）、anthropic（Messages API）、openai_compatible
 * （/chat/completions）。complete 非流式，stream 流式（SSE）。
 */
import type {
  LlmClient,
  LlmRequest,
  LlmResult,
  LlmStreamHandler,
  ChatMessage,
  ChatToolCall,
  ProviderConfig,
  TokenUsage,
} from "./types.js";
import { DEFAULT_ENDPOINTS, OPENAI_COMPATIBLE_TYPES } from "./provider-registry.js";
import { compactRecord } from "./record-utils.js";
import { extractText, toResponsesContent, toAnthropicContent } from "./content-parts.js";

export class OpenAiCompatibleClient implements LlmClient {
  async complete(request: LlmRequest): Promise<LlmResult> {
    if (request.provider.provider_type === "openai_resp") {
      return completeOpenAiResponses(request);
    }
    if (request.provider.provider_type === "anthropic") {
      return completeAnthropicMessages(request);
    }
    const { endpoint, apiKey } = resolveOpenAiCompatibleRequest(request);
    const response = await fetch(endpoint, buildFetchOptions(request, apiKey, false));
    const body = await readJsonResponseBody(response);
    if (!response.ok) {
      throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
    }
    const content = extractAssistantContent(body);
    const reasoning = extractReasoningContent(body);
    const toolCalls = extractAssistantToolCalls(body);
    const finishReason = extractFinishReason(body);
    if (!content && !reasoning && toolCalls.length === 0) {
      throw new Error(
        `LLM response did not include assistant content (finishReason=${finishReason ?? "unknown"})`,
      );
    }
    const result: LlmResult = { content: content ?? "", raw: body, finishReason };
    if (reasoning) {
      result.reasoning = reasoning;
    }
    if (toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }
    const usage = extractOpenAiUsage(body);
    if (usage) {
      result.usage = usage;
    }
    return result;
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    // Responses API 无流式契约，降级为非流式后单次 emit。
    if (request.provider.provider_type === "openai_resp") {
      const result = await this.complete(request);
      if (result.content) {
        await onChunk({ content: result.content, raw: result.raw });
      }
      return result;
    }
    if (request.provider.provider_type === "anthropic") {
      const apiKey = requireApiKey(request.provider);
      const endpoint = resolveAnthropicEndpoint(request.provider);
      const fetchOptions: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(buildAnthropicBody(request, true)),
      };
      if (request.signal) {
        fetchOptions.signal = request.signal;
      }
      const response = await fetch(endpoint, fetchOptions);
      if (!response.ok) {
        const body = await readJsonResponseBody(response);
        throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
      }
      return readAnthropicStream(response, onChunk, { allowEmptyContent: request.allowEmptyStream === true });
    }
    const { endpoint, apiKey } = resolveOpenAiCompatibleRequest(request);
    const response = await fetch(endpoint, buildFetchOptions(request, apiKey, true));
    if (!response.ok) {
      const body = await readJsonResponseBody(response);
      throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
    }
    return readOpenAiCompatibleStream(response, onChunk, { allowEmptyContent: request.allowEmptyStream === true });
  }
}

// ────────────────────────────── OpenAI Responses（非流式） ──────────────────────────────

async function completeOpenAiResponses(request: LlmRequest): Promise<LlmResult> {
  const apiKey = requireApiKey(request.provider);
  const endpoint = resolveResponsesEndpoint(request.provider);
  const fetchOptions: RequestInit = {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(buildResponsesBody(request)),
  };
  if (request.signal) {
    fetchOptions.signal = request.signal;
  }
  const response = await fetch(endpoint, fetchOptions);
  const body = await readJsonResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
  }
  const content = extractResponsesContent(body);
  if (!content) {
    throw new Error("OpenAI Responses output did not include assistant content");
  }
  const result: LlmResult = { content, raw: body, finishReason: extractResponsesFinishReason(body) };
  const usage = extractOpenAiUsage(body);
  if (usage) {
    result.usage = usage;
  }
  return result;
}

// ────────────────────────────── Anthropic Messages（非流式） ──────────────────────────────

async function completeAnthropicMessages(request: LlmRequest): Promise<LlmResult> {
  const apiKey = requireApiKey(request.provider);
  const endpoint = resolveAnthropicEndpoint(request.provider);
  const fetchOptions: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(buildAnthropicBody(request)),
  };
  if (request.signal) {
    fetchOptions.signal = request.signal;
  }
  const response = await fetch(endpoint, fetchOptions);
  const body = await readJsonResponseBody(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
  }
  const content = extractAnthropicContent(body);
  const toolCalls = extractAnthropicToolCalls(body);
  if (!content && toolCalls.length === 0) {
    throw new Error("Anthropic response did not include assistant content");
  }
  const result: LlmResult = {
    content: content ?? "",
    raw: body,
    finishReason: isRecord(body) && typeof body.stop_reason === "string" ? body.stop_reason : null,
  };
  if (toolCalls.length > 0) {
    result.toolCalls = toolCalls;
  }
  const usage = extractAnthropicUsage(body);
  if (usage) {
    result.usage = usage;
  }
  return result;
}

// ────────────────────────────── OpenAI 兼容（/chat/completions） ──────────────────────────────

function buildFetchOptions(request: LlmRequest, apiKey: string, stream: boolean): RequestInit {
  const options: RequestInit = {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(buildChatCompletionBody(request, stream)),
  };
  if (request.signal) {
    options.signal = request.signal;
  }
  return options;
}

function resolveOpenAiCompatibleRequest(request: LlmRequest): { endpoint: string; apiKey: string } {
  if (!OPENAI_COMPATIBLE_TYPES.has(request.provider.provider_type)) {
    throw new Error(
      `Provider type '${request.provider.provider_type}' is not supported by the OpenAI-compatible client`,
    );
  }
  return { endpoint: resolveChatEndpoint(request.provider), apiKey: requireApiKey(request.provider) };
}

function requireApiKey(provider: ProviderConfig): string {
  const apiKey = String(provider.api_key ?? "").trim();
  if (!apiKey) {
    throw new Error("Provider API key is required");
  }
  return apiKey;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

function buildChatCompletionBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
  return {
    ...compactRecord(request.extraParams),
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? undefined,
    max_tokens: request.maxCompletionTokens ?? undefined,
    tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
    tool_choice: request.tools && request.tools.length > 0 ? (request.toolChoice ?? "auto") : undefined,
    stream: stream ? true : undefined,
    // 流式时要求末尾 chunk 携带累计 usage,否则 token 用量无从获取。
    stream_options: stream ? { include_usage: true } : undefined,
  };
}

// ────────────────────────────── endpoint 解析 ──────────────────────────────

function resolveChatEndpoint(provider: ProviderConfig): string {
  const normalized = resolveBaseEndpoint(provider);
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function resolveResponsesEndpoint(provider: ProviderConfig): string {
  const normalized = resolveBaseEndpoint(provider);
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function resolveAnthropicEndpoint(provider: ProviderConfig): string {
  const normalized = resolveBaseEndpoint(provider);
  return normalized.endsWith("/messages") ? normalized : `${normalized}/v1/messages`;
}

function resolveBaseEndpoint(provider: ProviderConfig): string {
  const baseUrl = String(provider.api_endpoint ?? DEFAULT_ENDPOINTS[provider.provider_type] ?? "").trim();
  if (!baseUrl) {
    throw new Error(`Provider '${provider.name}' is missing api_endpoint`);
  }
  return baseUrl.replace(/\/+$/, "");
}

// ────────────────────────────── 请求体构造（Responses / Anthropic） ──────────────────────────────

function buildResponsesBody(request: LlmRequest): Record<string, unknown> {
  const instructions =
    request.messages.filter((m) => m.role === "system").map((m) => extractText(m.content)).join("\n\n") || undefined;
  const input = request.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      // 图片只在 user 消息；string content 保持 Responses 简化形态，array（带图）转 input part 数组。
      content: typeof m.content === "string" ? m.content : toResponsesContent(m.content),
    }));
  return {
    ...compactRecord(request.extraParams),
    model: request.model,
    input,
    instructions,
    temperature: request.temperature ?? undefined,
    max_output_tokens: request.maxCompletionTokens ?? undefined,
    tools:
      request.tools && request.tools.length > 0
        ? request.tools.map((t) => ({
            type: "function",
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          }))
        : undefined,
  };
}

function buildAnthropicBody(request: LlmRequest, stream = false): Record<string, unknown> {
  const system = request.messages
    .filter((m) => m.role === "system")
    .map((m) => ({ type: "text", text: extractText(m.content) }));
  const messages = request.messages
    .filter((m) => m.role !== "system")
    .map((m) => mapAnthropicMessage(m));
  return {
    ...compactRecord(request.extraParams),
    model: request.model,
    messages,
    system: system.length > 0 ? system : undefined,
    temperature: request.temperature ?? undefined,
    max_tokens:
      request.maxCompletionTokens ?? request.provider.max_completion_tokens ?? request.provider.max_tokens ?? 4096,
    tools:
      request.tools && request.tools.length > 0
        ? request.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
          }))
        : undefined,
    tool_choice: request.tools && request.tools.length > 0 ? mapAnthropicToolChoice(request.toolChoice) : undefined,
    stream: stream ? true : undefined,
  };
}

function mapAnthropicMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: extractText(message.content),
        },
      ],
    };
  }
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    const content: unknown[] = [];
    if (message.content) {
      content.push({ type: "text", text: extractText(message.content) });
    }
    for (const toolCall of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input: JSON.parse(toolCall.function.arguments || "{}"),
      });
    }
    return { role: "assistant", content };
  }
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    // user 消息可能带图（ContentPart[]）→ Anthropic text/image blocks；纯文本消息走同一 helper。
    content: toAnthropicContent(message.content),
  };
}

function mapAnthropicToolChoice(toolChoice: "auto" | "none" | undefined): Record<string, unknown> {
  return toolChoice === "none" ? { type: "none" } : { type: "auto" };
}

// ────────────────────────────── SSE 流式读取 ──────────────────────────────

interface StreamReadOptions {
  allowEmptyContent: boolean;
}

async function readOpenAiCompatibleStream(
  response: Response,
  onChunk: LlmStreamHandler,
  options: StreamReadOptions,
): Promise<LlmResult> {
  if (!response.body) {
    throw new Error("LLM streaming response did not include a readable body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let done = false;
  let stopRequested = false;
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  const toolCallAccumulators = new Map<number, StreamToolAccumulator>();

  const processLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) {
      return;
    }
    const data = trimmed.slice("data:".length).trim();
    if (!data) {
      return;
    }
    if (data === "[DONE]") {
      done = true;
      return;
    }
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const chunkUsage = extractOpenAiUsage(parsed);
    if (chunkUsage) {
      usage = chunkUsage;
    }
    const chunkFinishReason = extractStreamFinishReason(parsed);
    if (chunkFinishReason) {
      finishReason = chunkFinishReason;
      if (chunkFinishReason === "interrupted") {
        done = true;
      }
    }
    accumulateStreamToolCalls(parsed, toolCallAccumulators);
    // 思考模型思维链走 reasoning_content：消化但不向前端 emit，仅用于流末非空判定。
    const reasoningDelta = extractStreamReasoningDelta(parsed);
    if (reasoningDelta) {
      reasoning += reasoningDelta;
    }
    const delta = extractAssistantDeltaContent(parsed);
    if (delta) {
      content += delta;
      const control = await onChunk({ content: delta, finishReason: chunkFinishReason, raw: parsed });
      if (control?.stop) {
        stopRequested = true;
        done = true;
      }
    }
  };

  const processBuffer = async (flush: boolean): Promise<void> => {
    const lines = buffer.split(/\r?\n/);
    buffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      await processLine(line);
      if (done) {
        break;
      }
    }
  };

  while (!done) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    buffer += decoder.decode(read.value, { stream: true });
    await processBuffer(false);
  }
  buffer += decoder.decode();
  if (!done && buffer) {
    await processBuffer(true);
  }
  if (done) {
    await reader.cancel().catch(() => undefined);
  }

  const toolCalls = collectStreamToolCalls(toolCallAccumulators);
  if (toolCalls.length > 0 && !stopRequested) {
    await onChunk({ content: "", finishReason, toolCalls });
  }
  if (
    !content &&
    !reasoning &&
    toolCalls.length === 0 &&
    finishReason !== "interrupted" &&
    !stopRequested &&
    !options.allowEmptyContent
  ) {
    throw new Error(
      `LLM streaming response did not include assistant content (finishReason=${finishReason ?? "unknown"})`,
    );
  }
  const result: LlmResult = { content, finishReason };
  if (reasoning) {
    result.reasoning = reasoning;
  }
  if (toolCalls.length > 0) {
    result.toolCalls = toolCalls;
  }
  if (usage) {
    result.usage = usage;
  }
  return result;
}

interface StreamToolAccumulator {
  id: string;
  name: string;
  argsBuffer: string;
}

async function readAnthropicStream(
  response: Response,
  onChunk: LlmStreamHandler,
  options: StreamReadOptions,
): Promise<LlmResult> {
  if (!response.body) {
    throw new Error("Anthropic streaming response did not include a readable body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let done = false;
  let stopRequested = false;
  let finishReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsage = false;
  const blockTools = new Map<number, StreamToolAccumulator>();

  const finalizeBlock = (index: number): ChatToolCall | null => {
    const acc = blockTools.get(index);
    if (!acc || !acc.name) {
      return null;
    }
    blockTools.delete(index);
    return { id: acc.id, type: "function", function: { name: acc.name, arguments: acc.argsBuffer } };
  };

  const processEvent = async (event: { event: string; data: string }): Promise<void> => {
    const data = event.data.trim();
    if (!data) {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (event.event) {
      case "message_start": {
        // message_start 携带 input_tokens(以及起始 output_tokens);output 以 message_delta 的累计值为准。
        const message = isRecord(parsed) ? parsed.message : undefined;
        const startUsage = extractAnthropicUsage(message);
        if (startUsage) {
          inputTokens = startUsage.inputTokens;
          hasUsage = true;
        }
        break;
      }
      case "content_block_start": {
        const index = isRecord(parsed) && typeof parsed.index === "number" ? parsed.index : 0;
        const block = isRecord(parsed) ? parsed.content_block : undefined;
        if (isRecord(block) && block.type === "tool_use") {
          const name = block.name;
          blockTools.set(index, {
            id: typeof block.id === "string" && block.id.trim() ? block.id : `tool_call_${index}`,
            name: typeof name === "string" ? name : "",
            argsBuffer: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const index = isRecord(parsed) && typeof parsed.index === "number" ? parsed.index : 0;
        const delta = isRecord(parsed) ? parsed.delta : undefined;
        if (!isRecord(delta)) {
          break;
        }
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          content += delta.text;
          const control = await onChunk({ content: delta.text, finishReason, raw: parsed });
          if (control?.stop) {
            stopRequested = true;
            done = true;
          }
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const acc = blockTools.get(index);
          if (acc) {
            acc.argsBuffer += delta.partial_json;
          }
        }
        break;
      }
      case "content_block_stop": {
        const index = isRecord(parsed) && typeof parsed.index === "number" ? parsed.index : 0;
        const finalized = finalizeBlock(index);
        if (finalized && !stopRequested) {
          await onChunk({ content: "", finishReason, toolCalls: [finalized] });
        }
        break;
      }
      case "message_delta": {
        const inner = isRecord(parsed) ? parsed.delta : undefined;
        if (isRecord(inner) && typeof inner.stop_reason === "string") {
          finishReason = inner.stop_reason;
        }
        // message_delta 的 usage.output_tokens 为累计值,直接覆盖。
        const deltaUsage = extractAnthropicUsage(parsed);
        if (deltaUsage) {
          outputTokens = deltaUsage.outputTokens;
          hasUsage = true;
        }
        break;
      }
      case "message_stop": {
        done = true;
        break;
      }
      default:
        break;
    }
  };

  const processBuffer = async (flush: boolean): Promise<void> => {
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = flush ? "" : (events.pop() ?? "");
    for (const rawEvent of events) {
      const lines = rawEvent.split(/\r?\n/);
      let eventType = "";
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }
      if (!eventType) {
        continue;
      }
      await processEvent({ event: eventType, data: dataLines.join("\n") });
      if (done) {
        break;
      }
    }
  };

  while (!done) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    buffer += decoder.decode(read.value, { stream: true });
    await processBuffer(false);
  }
  buffer += decoder.decode();
  if (!done && buffer.trim()) {
    await processBuffer(true);
  }
  if (done) {
    await reader.cancel().catch(() => undefined);
  }

  if (!content && blockTools.size === 0 && finishReason !== "interrupted" && !stopRequested && !options.allowEmptyContent) {
    throw new Error("Anthropic streaming response did not include assistant content");
  }
  // 收尾：未收到 content_block_stop 的 tool 块（截断流）。
  const trailingToolCalls: ChatToolCall[] = [];
  for (const index of Array.from(blockTools.keys()).sort((a, b) => a - b)) {
    const finalized = finalizeBlock(index);
    if (finalized) {
      trailingToolCalls.push(finalized);
    }
  }
  const result: LlmResult = { content, finishReason };
  if (trailingToolCalls.length > 0 && !stopRequested) {
    await onChunk({ content: "", finishReason, toolCalls: trailingToolCalls });
    result.toolCalls = trailingToolCalls;
  }
  if (hasUsage) {
    result.usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }
  return result;
}

// ────────────────────────────── 响应解析辅助 ──────────────────────────────

async function readJsonResponseBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text };
  }
}

function extractFirstChoice(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) {
    return null;
  }
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0];
  return isRecord(first) ? first : null;
}

function extractAssistantContent(body: unknown): string | null {
  const first = extractFirstChoice(body);
  if (!first) {
    return null;
  }
  const message = first.message;
  if (isRecord(message) && typeof message.content === "string") {
    return message.content;
  }
  if (typeof first.text === "string") {
    return first.text;
  }
  return null;
}

function extractReasoningContent(body: unknown): string | null {
  const first = extractFirstChoice(body);
  if (!first) {
    return null;
  }
  const message = first.message;
  if (isRecord(message) && typeof message.reasoning_content === "string") {
    return message.reasoning_content;
  }
  return null;
}

function extractAssistantToolCalls(body: unknown): ChatToolCall[] {
  const first = extractFirstChoice(body);
  if (!first) {
    return [];
  }
  const message = first.message;
  if (!isRecord(message) || !Array.isArray(message.tool_calls)) {
    return [];
  }
  const toolCalls: ChatToolCall[] = [];
  for (const [index, item] of message.tool_calls.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    const fn = item.function;
    if (!isRecord(fn) || typeof fn.name !== "string") {
      continue;
    }
    toolCalls.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id : `tool_call_${index}`,
      type: "function",
      function: {
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    });
  }
  return toolCalls;
}

function extractFinishReason(body: unknown): string | null {
  const first = extractFirstChoice(body);
  if (!first) {
    return null;
  }
  return typeof first.finish_reason === "string" ? first.finish_reason : null;
}

function extractResponsesContent(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  if (typeof body.output_text === "string" && body.output_text) {
    return body.output_text;
  }
  const output = body.output;
  if (!Array.isArray(output)) {
    return null;
  }
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const content = item.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (isRecord(block) && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("");
}

function extractResponsesFinishReason(body: unknown): string | null {
  if (isRecord(body) && typeof body.status === "string") {
    return body.status;
  }
  return null;
}

function extractAnthropicContent(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of body.content) {
    if (isRecord(block) && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function extractAnthropicToolCalls(body: unknown): ChatToolCall[] {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    return [];
  }
  const toolCalls: ChatToolCall[] = [];
  for (const [index, block] of body.content.entries()) {
    if (!isRecord(block) || block.type !== "tool_use") {
      continue;
    }
    const name = block.name;
    if (typeof name !== "string" || !name) {
      continue;
    }
    const input = block.input;
    toolCalls.push({
      id: typeof block.id === "string" && block.id.trim() ? block.id : `tool_call_${index}`,
      type: "function",
      function: {
        name,
        arguments: typeof input === "string" ? input : JSON.stringify(input ?? {}),
      },
    });
  }
  return toolCalls;
}

function extractAssistantDeltaContent(body: unknown): string | null {
  const first = extractFirstChoice(body);
  if (!first) {
    return null;
  }
  const delta = first.delta;
  if (isRecord(delta) && typeof delta.content === "string") {
    return delta.content;
  }
  if (typeof first.text === "string") {
    return first.text;
  }
  return null;
}

function extractStreamReasoningDelta(body: unknown): string | null {
  const first = extractFirstChoice(body);
  if (!first) {
    return null;
  }
  const delta = first.delta;
  if (isRecord(delta) && typeof delta.reasoning_content === "string") {
    return delta.reasoning_content;
  }
  return null;
}

function extractStreamFinishReason(body: unknown): string | null {
  const first = extractFirstChoice(body);
  if (!first) {
    return null;
  }
  return typeof first.finish_reason === "string" ? first.finish_reason : null;
}

function accumulateStreamToolCalls(body: unknown, accumulators: Map<number, StreamToolAccumulator>): void {
  const first = extractFirstChoice(body);
  if (!first) {
    return;
  }
  const delta = first.delta;
  if (!isRecord(delta) || !Array.isArray(delta.tool_calls)) {
    return;
  }
  for (const entry of delta.tool_calls) {
    if (!isRecord(entry)) {
      continue;
    }
    const index = typeof entry.index === "number" ? entry.index : 0;
    let acc = accumulators.get(index);
    if (!acc) {
      acc = {
        id: typeof entry.id === "string" && entry.id.trim() ? entry.id : `tool_call_${index}`,
        name: "",
        argsBuffer: "",
      };
      accumulators.set(index, acc);
    }
    if (typeof entry.id === "string" && entry.id.trim()) {
      acc.id = entry.id;
    }
    const fn = entry.function;
    if (isRecord(fn)) {
      if (typeof fn.name === "string" && fn.name) {
        acc.name = acc.name || fn.name;
      }
      if (typeof fn.arguments === "string") {
        acc.argsBuffer += fn.arguments;
      }
    }
  }
}

function collectStreamToolCalls(accumulators: Map<number, StreamToolAccumulator>): ChatToolCall[] {
 const toolCalls: ChatToolCall[] = [];
  for (const index of Array.from(accumulators.keys()).sort((a, b) => a - b)) {
    const acc = accumulators.get(index);
    if (!acc || !acc.name) {
      continue;
    }
    toolCalls.push({ id: acc.id, type: "function", function: { name: acc.name, arguments: acc.argsBuffer } });
  }
  return toolCalls;
}

function extractErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const error = body.error;
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof body.message === "string") {
    return body.message;
  }
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 从 OpenAI 兼容响应体提取 token 用量,覆盖两套字段命名:
 * - /chat/completions:usage.prompt_tokens / completion_tokens / total_tokens
 * - /responses(及部分兼容网关):usage.input_tokens / output_tokens / total_tokens
 * 流式末尾 chunk(choices 空、仅带 usage)同样命中。
 */
function extractOpenAiUsage(body: unknown): TokenUsage | null {
  if (!isRecord(body)) {
    return null;
  }
  const usage = body.usage;
  if (!isRecord(usage)) {
    return null;
  }
  const prompt = toFiniteNumber(usage.prompt_tokens);
  const completion = toFiniteNumber(usage.completion_tokens);
  const input = toFiniteNumber(usage.input_tokens);
  const output = toFiniteNumber(usage.output_tokens);
  const inputTokens = prompt ?? input;
  const outputTokens = completion ?? output;
  if (inputTokens === null && outputTokens === null) {
    return null;
  }
  const total = toFiniteNumber(usage.total_tokens);
  const inT = inputTokens ?? 0;
  const outT = outputTokens ?? 0;
  return {
    inputTokens: inT,
    outputTokens: outT,
    totalTokens: total ?? inT + outT,
  };
}

/**
 * 从 Anthropic 响应体提取 token 用量:usage.input_tokens / output_tokens。
 * message_start 提供 input(及起始 output),message_delta 提供累计 output。
 */
function extractAnthropicUsage(body: unknown): TokenUsage | null {
  if (!isRecord(body)) {
    return null;
  }
  const usage = body.usage;
  if (!isRecord(usage)) {
    return null;
  }
  const inputTokens = toFiniteNumber(usage.input_tokens);
  const outputTokens = toFiniteNumber(usage.output_tokens);
  if (inputTokens === null && outputTokens === null) {
    return null;
  }
  const inT = inputTokens ?? 0;
  const outT = outputTokens ?? 0;
  return { inputTokens: inT, outputTokens: outT, totalTokens: inT + outT };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
