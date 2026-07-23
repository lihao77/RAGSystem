/** Tenant-scoped asynchronous vector data-plane contract shared by all runtimes. */
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
export interface AsyncVectorSearchInput {
  tenant_id: string;
  collection?: string;
  model_id: number;
  query_vector: number[];
  top_k: number;
  /** Exact JSON-containment filter applied to chunk metadata. */
  filters?: Record<string, unknown>;
}
export interface AsyncVectorSearchHit { id: string; tenant_id: string; collection: string; document_id: string; model_id: number; chunk_index: number; content: string; metadata: Record<string, unknown>; vector_score: number; }
export interface AsyncKnowledgeCollectionSummary { name: string; document_count: number; chunk_count: number; total_chunks: number; embedding_dimension: number | null; }
export interface AsyncKnowledgeDocumentIndexSummary {
  collection: string;
  document_id: string;
  model_id: number;
  chunk_count: number;
}
/** Logical chunk view. The opaque id is stable across model reindexing. */
export interface AsyncKnowledgeChunk {
  id: string;
  tenant_id: string;
  collection: string;
  document_id: string;
  model_id: number;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
}
export interface AsyncKnowledgeDocumentSummary {
  collection: string;
  document_id: string;
  chunk_count: number;
  metadata: Record<string, unknown> | null;
}
export interface AsyncKnowledgeVectorStore {
  upsertChunks(records: AsyncVectorRecord[]): Promise<void>;
  replaceChunks(input: {
    tenant_id: string;
    collection: string;
    document_id: string;
    model_id: number;
    records: AsyncVectorRecord[];
  }): Promise<void>;
  search(input: AsyncVectorSearchInput): Promise<AsyncVectorSearchHit[]>;
  listCollections(tenantId: string): Promise<AsyncKnowledgeCollectionSummary[]>;
  listDocumentIndexes(tenantId: string): Promise<AsyncKnowledgeDocumentIndexSummary[]>;
  listChunks(input: { tenant_id: string; collection?: string; document_id?: string; model_id?: number }): Promise<AsyncKnowledgeChunk[]>;
  getChunk(tenantId: string, chunkId: string): Promise<AsyncKnowledgeChunk | null>;
  listChunkVersions(tenantId: string, chunkId: string): Promise<AsyncKnowledgeChunk[]>;
  listDocuments(input: { tenant_id: string; collection: string }): Promise<AsyncKnowledgeDocumentSummary[]>;
  listAllDocuments(tenantId: string): Promise<AsyncKnowledgeDocumentSummary[]>;
  countVectors(input: { tenant_id: string; collection: string; model_id: number }): Promise<number>;
  countVectorsByModel(input: { tenant_id: string; model_id: number }): Promise<Array<{ collection: string; count: number }>>;
  countVectorsForDocument(input: { tenant_id: string; collection: string; document_id: string; model_id: number }): Promise<number>;
  countChunks(input: { tenant_id: string; collection: string }): Promise<number>;
  getDimension(input: { tenant_id: string; model_id: number }): Promise<number | null>;
  health(tenantId: string): Promise<{ status: string; runtime: string; ann: boolean; collections_count: number }>;
  deleteChunks(input: { tenant_id: string; collection?: string; document_id?: string; model_id?: number }): Promise<number>;
  deleteCollection(input: { tenant_id: string; collection: string }): Promise<number>;
}
