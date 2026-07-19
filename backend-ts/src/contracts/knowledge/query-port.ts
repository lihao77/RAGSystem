import type { SearchVectorsRequest, VectorSearchResult } from "../knowledge-base.js";

export interface KnowledgeCollectionSummary {
  name: string;
  document_count: number;
  chunk_count: number;
  total_chunks?: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchResponse {
  results: VectorSearchResult[];
  count: number;
  collection_name: string;
  query: string;
  search_mode: "hybrid" | "vector";
  rerank: boolean;
  rerank_mode: "model" | "lexical" | "none" | "degraded";
}

/** Read-only knowledge boundary consumed by Agent tools. */
export interface KnowledgeQueryPort {
  search(input: SearchVectorsRequest): Promise<KnowledgeSearchResponse>;
  listCollections(): Promise<KnowledgeCollectionSummary[]>;
}
