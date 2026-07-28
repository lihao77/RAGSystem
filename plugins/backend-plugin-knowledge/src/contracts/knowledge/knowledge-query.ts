import type { VectorSearchResult } from "./knowledge-base.js";

export interface KnowledgeCollectionSummary {
  name: string;
  document_count: number;
  chunk_count: number;
  total_chunks?: number;
  embedding_dimension?: number;
  model_name?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchResponse {
  results: VectorSearchResult[];
  count: number;
  collection_name: string | null;
  collection_scope: "single" | "all";
  query: string;
  search_mode: "hybrid" | "vector";
  rerank_requested: boolean;
  rerank: boolean;
  rerank_mode: "model" | "lexical" | "none" | "degraded";
  rerank_error: string | null;
  diagnostics: {
    candidate_count: number;
    vector_candidate_count: number;
    keyword_candidate_count: number;
    fused_candidate_count: number;
    filters_applied: string[];
    fusion: {
      method: "rrf";
      rrf_k: number;
    } | null;
    vectorizer: {
      vectorizer_key: string;
      provider_key: string;
      model_name: string;
      model_id: number;
    };
    reranker: {
      reranker_key: string;
      provider_key: string;
      model_name: string;
      mode: "model" | "lexical" | "none";
    } | null;
    timings_ms: {
      embedding: number;
      retrieval: number;
      vector_retrieval: number;
      keyword_retrieval: number;
      scoring: number;
      rerank: number;
      total: number;
    };
  };
}
