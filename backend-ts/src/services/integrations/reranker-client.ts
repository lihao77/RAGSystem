import type { StoredReranker } from "../../contracts/vector-store/index.js";
import { externalCallPolicy, isRetryableHttpStatus, RetryableHttpError } from "@ragsystem/agent-llm";
import { resolveEnvPlaceholder } from "./embedding-client.js";

export interface RerankRequest {
  query: string;
  documents: string[];
  reranker: StoredReranker;
  topN?: number | undefined;
}

export interface RerankClient {
  rerank(request: RerankRequest): Promise<number[]>;
}

/** OpenAI 兼容 rerank 客户端。 */
export class OpenAiCompatibleRerankClient implements RerankClient {
  async rerank(request: RerankRequest): Promise<number[]> {
    if (request.documents.length === 0) return [];
    const endpoint = resolveRerankEndpoint(request.reranker);
    const apiKey = resolveApiKey(request.reranker);
    const { response, body } = await externalCallPolicy.execute({
      key: `reranker:${request.reranker.reranker_key}`,
      operation: async ({ signal }) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: request.reranker.model_name,
            query: request.query,
            documents: request.documents,
            ...(request.topN ? { top_n: request.topN } : {}),
          }),
          signal,
        });
        const body = await readJsonResponseBody(response);
        if (isRetryableHttpStatus(response.status)) {
          throw new RetryableHttpError(response.status, extractErrorMessage(body) ?? `Rerank request failed with HTTP ${response.status}`);
        }
        return { response, body };
      },
    });
    if (!response.ok) throw new Error(extractErrorMessage(body) ?? `Rerank request failed with HTTP ${response.status}`);
    return extractScores(body, request.documents.length);
  }
}

function resolveRerankEndpoint(reranker: StoredReranker): string {
  const raw = resolveEnvPlaceholder(reranker.api_endpoint).trim();
  if (!raw) throw new Error(`Reranker '${reranker.reranker_key}' is missing api_endpoint`);
  const normalized = raw.replace(/\/+$/, "");
  return normalized.endsWith("/rerank") ? normalized : `${normalized}/rerank`;
}

function resolveApiKey(reranker: StoredReranker): string {
  const apiKey = resolveEnvPlaceholder(reranker.api_key ?? "").trim();
  if (!apiKey) throw new Error("Reranker API key is required");
  return apiKey;
}

async function readJsonResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { return { message: text }; }
}

function extractScores(body: unknown, count: number): number[] {
  if (!isRecord(body) || !Array.isArray(body.results)) throw new Error("Rerank response missing results array");
  if (body.results.length !== count) throw new Error(`Rerank response count mismatch: expected ${count}, got ${body.results.length}`);
  const scores = Array.from({ length: count }, () => Number.NaN);
  for (const item of body.results) {
    if (!isRecord(item) || typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0 || item.index >= count) throw new Error("Rerank response item has invalid index");
    const rawScore = item.relevance_score ?? item.score;
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) throw new Error("Rerank response item missing score");
    scores[item.index] = rawScore;
  }
  if (scores.some(Number.isNaN)) throw new Error("Rerank response missing result index");
  return scores;
}

function extractErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return typeof body.message === "string" ? body.message : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
