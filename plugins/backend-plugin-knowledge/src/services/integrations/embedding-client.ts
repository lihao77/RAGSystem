/**
 * Embedding client（OpenAI 兼容 POST /embeddings）——知识库插件自管 Provider 的调用端。
 * （自 core 搬入：embedding 是知识库的外来概念，随 Provider 存储一起归插件。）
 *
 * 深合约：
 * - embed 批量 POST {model, input:texts}，解析 data[].embedding，返回顺序与输入一致；
 *   空输入返回空数组（不请求）；响应数量不匹配抛异常（前置违反）；
 * - api_key 与 api_endpoint 支持 ${ENV_VAR} 占位符（敏感值不落盘明文）；
 * - HTTP 非 2xx 抛异常（携带响应 message），非静默。
 */
import {
  externalCallPolicy,
  isRetryableHttpStatus,
  providerCallPolicy,
  RetryableHttpError,
} from "@ragsystem/agent-llm";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

import type { EmbeddingClientPort, EmbeddingRequest, KnowledgeModelProvider } from "../../contracts/knowledge/model-providers.js";

export class OpenAiCompatibleEmbeddingClient implements EmbeddingClientPort {
  async embed(request: EmbeddingRequest): Promise<number[][]> {
    if (request.texts.length === 0) {
      return [];
    }
    const apiKey = resolveApiKey(request.provider);
    const endpoint = resolveEmbeddingsEndpoint(request.provider);
    const providerKey = request.provider.provider_key || request.provider.name;
    const { response, body } = await externalCallPolicy.execute({
      key: `knowledge-embedding:${providerKey}`,
      ...providerCallPolicy(request.provider as unknown as Record<string, unknown>),
      operation: async ({ signal }) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: request.model, input: request.texts }),
          signal,
        });
        const body = await readJsonResponseBody(response);
        if (isRetryableHttpStatus(response.status)) {
          throw new RetryableHttpError(
            response.status,
            extractErrorMessage(body) ?? `Embedding request failed with HTTP ${response.status}`,
          );
        }
        return { response, body };
      },
    });
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

function resolveEmbeddingsEndpoint(provider: KnowledgeModelProvider): string {
  const raw = resolveEnvPlaceholder(provider.api_endpoint).trim();
  if (!raw) {
    throw new Error(`模型服务 '${provider.name}' 未配置 api_endpoint`);
  }
  const normalized = raw.replace(/\/+$/, "");
  return normalized.endsWith("/embeddings") ? normalized : `${normalized}/embeddings`;
}

function resolveApiKey(provider: KnowledgeModelProvider): string {
  const apiKey = resolveEnvPlaceholder(provider.api_key).trim();
  if (!apiKey) {
    throw new Error(`模型服务 '${provider.name}' 未配置 API Key`);
  }
  return apiKey;
}

/**
 * ${ENV_VAR} 占位符解析：value 含 ${VAR} → process.env[VAR]。
 * 未定义的变量保留原占位符（不抛错，交由上层校验）。
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
