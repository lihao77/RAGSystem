import type { AgentConfig } from "../contracts/agent-config.js";
import type { ModelProviderConfig } from "../contracts/model-adapter.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string | undefined;
  tool_call_id?: string | undefined;
  tool_calls?: ChatToolCall[] | undefined;
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string | undefined;
    parameters: Record<string, unknown>;
  };
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model: string;
  provider: ModelProviderConfig;
  agent: AgentConfig;
  signal?: AbortSignal;
  temperature?: number | null;
  maxCompletionTokens?: number | null;
  tools?: ChatToolDefinition[] | undefined;
  toolChoice?: "auto" | "none" | undefined;
}

export interface ChatCompletionResult {
  content: string;
  raw?: unknown;
  finishReason?: string | null | undefined;
  toolCalls?: ChatToolCall[] | undefined;
}

export interface ChatStreamChunk {
  content: string;
  raw?: unknown;
}

export type ChatStreamChunkHandler = (chunk: ChatStreamChunk) => void | Promise<void>;

export interface LlmChatClient {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
  stream?(request: ChatCompletionRequest, onChunk: ChatStreamChunkHandler): Promise<ChatCompletionResult>;
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai_resp: "https://api.openai.com/v1",
  openai_chat: "https://api.openai.com/v1",
  openai_proxy: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  modelscope: "https://api-inference.modelscope.cn/v1",
};

const OPENAI_COMPATIBLE_TYPES = new Set(["openai_chat", "openai_proxy", "deepseek", "openrouter", "modelscope"]);

export class OpenAiCompatibleChatClient implements LlmChatClient {
  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const { endpoint, apiKey } = resolveOpenAiCompatibleRequest(request);
    const response = await fetch(endpoint, buildFetchOptions(request, apiKey, false));
    const body = await readJsonResponseBody(response);
    if (!response.ok) {
      throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
    }
    const content = extractAssistantContent(body);
    const toolCalls = extractAssistantToolCalls(body);
    if (!content && toolCalls.length === 0) {
      throw new Error("LLM response did not include assistant content");
    }
    const result: ChatCompletionResult = {
      content: content ?? "",
      raw: body,
      finishReason: extractFinishReason(body),
    };
    if (toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }
    return result;
  }

  async stream(request: ChatCompletionRequest, onChunk: ChatStreamChunkHandler): Promise<ChatCompletionResult> {
    const { endpoint, apiKey } = resolveOpenAiCompatibleRequest(request);
    const response = await fetch(endpoint, buildFetchOptions(request, apiKey, true));
    if (!response.ok) {
      const body = await readJsonResponseBody(response);
      throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
    }
    return readOpenAiCompatibleStream(response, onChunk);
  }
}

function buildFetchOptions(request: ChatCompletionRequest, apiKey: string, stream: boolean): RequestInit {
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

function resolveOpenAiCompatibleRequest(request: ChatCompletionRequest): { endpoint: string; apiKey: string } {
  if (!OPENAI_COMPATIBLE_TYPES.has(request.provider.provider_type)) {
    throw new Error(`Provider type '${request.provider.provider_type}' is not supported by the minimal TS runtime core`);
  }
  const apiKey = String(request.provider.api_key ?? "").trim();
  if (!apiKey) {
    throw new Error("Provider API key is required");
  }
  return {
    endpoint: resolveChatEndpoint(request.provider),
    apiKey,
  };
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
}

function buildChatCompletionBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? undefined,
    max_tokens: request.maxCompletionTokens ?? undefined,
    tools: request.tools?.length ? request.tools : undefined,
    tool_choice: request.tools?.length ? (request.toolChoice ?? "auto") : undefined,
    stream: stream ? true : undefined,
  };
}

function resolveChatEndpoint(provider: ModelProviderConfig): string {
  const baseUrl = String(provider.api_endpoint ?? DEFAULT_ENDPOINTS[provider.provider_type] ?? "").trim();
  if (!baseUrl) {
    throw new Error(`Provider '${provider.name}' is missing api_endpoint`);
  }
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  return `${normalized}/chat/completions`;
}

async function readOpenAiCompatibleStream(
  response: Response,
  onChunk: ChatStreamChunkHandler,
): Promise<ChatCompletionResult> {
  if (!response.body) {
    throw new Error("LLM streaming response did not include a readable body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let done = false;

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
    const parsed = JSON.parse(data) as unknown;
    const delta = extractAssistantDeltaContent(parsed);
    if (!delta) {
      return;
    }
    content += delta;
    await onChunk({ content: delta, raw: parsed });
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
  if (!content) {
    throw new Error("LLM streaming response did not include assistant content");
  }

  return { content };
}

async function readJsonResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
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

function extractAssistantDeltaContent(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0];
  if (!isRecord(first)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
