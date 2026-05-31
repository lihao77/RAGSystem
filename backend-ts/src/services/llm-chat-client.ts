import type { AgentConfig } from "../contracts/agent-config.js";
import type { ModelProviderConfig } from "../contracts/model-adapter.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model: string;
  provider: ModelProviderConfig;
  agent: AgentConfig;
  signal?: AbortSignal;
  temperature?: number | null;
  maxCompletionTokens?: number | null;
}

export interface ChatCompletionResult {
  content: string;
  raw?: unknown;
}

export interface LlmChatClient {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
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
    if (!OPENAI_COMPATIBLE_TYPES.has(request.provider.provider_type)) {
      throw new Error(`Provider type '${request.provider.provider_type}' is not supported by the minimal TS runtime core`);
    }
    const apiKey = String(request.provider.api_key ?? "").trim();
    if (!apiKey) {
      throw new Error("Provider API key is required");
    }
    const endpoint = resolveChatEndpoint(request.provider);
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? undefined,
        max_tokens: request.maxCompletionTokens ?? undefined,
      }),
    };
    if (request.signal) {
      fetchOptions.signal = request.signal;
    }
    const response = await fetch(endpoint, fetchOptions);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(extractErrorMessage(body) ?? `LLM request failed with HTTP ${response.status}`);
    }
    const content = extractAssistantContent(body);
    if (!content) {
      throw new Error("LLM response did not include assistant content");
    }
    return {
      content,
      raw: body,
    };
  }
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

function extractAssistantContent(body: unknown): string | null {
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
  const message = first.message;
  if (isRecord(message) && typeof message.content === "string") {
    return message.content;
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
