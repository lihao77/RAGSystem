/**
 * Embedding client(OpenAI 兼容 /embeddings)。
 *
 * 独立于 LlmChatClient(embedding 与 chat 是不同 API,刻意分开,对齐 Python EmbedderBase)。
 * 不处理 anthropic(无 embedding API)/openai_resp(走 /embeddings 同 chat 兼容)。仅 OpenAI 兼容 provider_type。
 *
 * 深合约:
 * - embed 批量 POST {model, input:texts},解析 data[].embedding,返回顺序与输入一致;
 *   空输入返回空数组(不请求);响应数量不匹配抛异常(前置违反);
 * - api_key 与 api_endpoint 支持 ${ENV_VAR} 占位符(resolveEnvPlaceholder),敏感值不落盘明文;
 * - HTTP 非 2xx 抛异常(携带响应 message),非静默。
 */
import type { ModelProviderConfig } from "../../contracts/model-adapter.js";
import { providerEmbeddingDefaultEndpoint } from "./provider-registry.js";

export interface EmbeddingRequest {
  texts: string[];
  model: string;
  provider: ModelProviderConfig;
}

export interface EmbeddingClient {
  embed(request: EmbeddingRequest): Promise<number[][]>;
}

export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
  async embed(request: EmbeddingRequest): Promise<number[][]> {
    if (request.texts.length === 0) {
      return [];
    }
    const apiKey = resolveApiKey(request.provider);
    const endpoint = resolveEmbeddingsEndpoint(request.provider);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: request.model, input: request.texts }),
    });
    const body = await readJsonResponseBody(response);
    if (!response.ok) {
      throw new Error(extractErrorMessage(body) ?? `Embedding request failed with HTTP ${response.status}`);
    }
    const vectors = extractEmbeddings(body);
    if (vectors.length !== request.texts.length) {
      throw new Error(
        `Embedding response count mismatch: expected ${request.texts.length}, got ${vectors.length}`,
      );
    }
    return vectors;
  }
}

function resolveEmbeddingsEndpoint(provider: ModelProviderConfig): string {
  const raw = resolveEnvPlaceholder(String(provider.api_endpoint ?? providerEmbeddingDefaultEndpoint(provider.provider_type))).trim();
  if (!raw) {
    throw new Error(`Provider '${provider.name}' is missing api_endpoint for embedding`);
  }
  const normalized = raw.replace(/\/+$/, "");
  return normalized.endsWith("/embeddings") ? normalized : `${normalized}/embeddings`;
}

function resolveApiKey(provider: ModelProviderConfig): string {
  const apiKey = resolveEnvPlaceholder(String(provider.api_key ?? "")).trim();
  if (!apiKey) {
    throw new Error("Provider API key is required for embedding");
  }
  return apiKey;
}

/**
 * ${ENV_VAR} 占位符解析(复用 Python factory.py:109 模式):value 含 ${VAR} → process.env[VAR]。
 * 未定义的变量保留原占位符(不抛错,交由上层 require 校验)。
 */
export function resolveEnvPlaceholder(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => process.env[name] ?? match);
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

function extractEmbeddings(body: unknown): number[][] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("Embedding response missing data array");
  }
  return body.data.map((item) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new Error("Embedding response item missing embedding array");
    }
    return item.embedding.map((value) => Number(value));
  });
}

function extractErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const error = body.error;
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return typeof body.message === "string" ? body.message : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
