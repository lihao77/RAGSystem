/** Tenant-scoped asynchronous vector data-plane contract for SaaS backends. */
export interface AsyncVectorRecord {
  id?: string;
  tenant_id: string;
  collection: string;
  document_id: string;
  model_id: number;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
}
export interface AsyncVectorSearchInput { tenant_id: string; collection: string; model_id: number; query_vector: number[]; top_k: number; }
export interface AsyncVectorSearchHit { id: string; tenant_id: string; collection: string; document_id: string; model_id: number; chunk_index: number; content: string; metadata: Record<string, unknown>; vector_score: number; }
export interface AsyncKnowledgeVectorStore {
  upsertChunks(records: AsyncVectorRecord[]): Promise<void>;
  search(input: AsyncVectorSearchInput): Promise<AsyncVectorSearchHit[]>;
  deleteChunks(input: { tenant_id: string; collection?: string; document_id?: string; model_id?: number }): Promise<number>;
}
