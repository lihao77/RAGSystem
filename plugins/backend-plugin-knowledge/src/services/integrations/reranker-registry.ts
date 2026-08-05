import type { RerankResultMode, VectorSearchResult } from "../../contracts/knowledge/knowledge-base.js";
import type { StoredReranker } from "../../contracts/vector-store/index.js";
import type { RerankClientPort } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import { lexicalRerank } from "../knowledge/rerank/lexical-rerank.js";

export interface IReranker {
  rerank(query: string, results: VectorSearchResult[]): Promise<{ results: VectorSearchResult[]; mode: RerankResultMode }>;
}

export function createReranker(stored: StoredReranker, client?: RerankClientPort): IReranker {
  if (stored.mode === "model") return new RemoteReranker(stored, client);
  if (stored.mode === "lexical") return new LexicalReranker();
  return new NoopReranker();
}

export class RemoteReranker implements IReranker {
  private readonly client: RerankClientPort;
  constructor(private readonly stored: StoredReranker, client?: RerankClientPort) {
    if (!client) throw new Error("Knowledge reranking requires a Model Adapter rerank client");
    this.client = client;
  }
  async rerank(query: string, results: VectorSearchResult[]): Promise<{ results: VectorSearchResult[]; mode: RerankResultMode }> {
    const scores = await this.client.rerank({ query, documents: results.map((result) => result.content), reranker: this.stored });
    return {
      results: results.map((result, index) => ({ ...result, rerank_score: scores[index]! })).sort((left, right) => (right.rerank_score ?? 0) - (left.rerank_score ?? 0)),
      mode: "model",
    };
  }
}

export class LexicalReranker implements IReranker {
  async rerank(query: string, results: VectorSearchResult[]): Promise<{ results: VectorSearchResult[]; mode: RerankResultMode }> {
    return { results: lexicalRerank(results, query), mode: "lexical" };
  }
}

export class NoopReranker implements IReranker {
  async rerank(_query: string, results: VectorSearchResult[]): Promise<{ results: VectorSearchResult[]; mode: RerankResultMode }> {
    return { results, mode: "none" };
  }
}
