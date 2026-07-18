/** Tenant-scoped asynchronous index metadata port.
 *
 * This port deliberately stores index state, not embedding payloads. SaaS
 * compositions can back it with PostgreSQL while the actual ANN/vector
 * engine is supplied independently (pgvector, Qdrant, etc.).
 */
export type KnowledgeVectorIndexStatus = "pending" | "indexed" | "failed";

export interface KnowledgeVectorIndexRecord {
  tenant_id: string;
  collection: string;
  document_id: string;
  model_id: number;
  chunk_count: number;
  embedding_dimension: number | null;
  status: KnowledgeVectorIndexStatus;
  error_message: string | null;
  indexed_at: string | null;
  updated_at: string;
}

export interface UpsertKnowledgeVectorIndexInput {
  tenant_id: string;
  collection: string;
  document_id: string;
  model_id: number;
  chunk_count: number;
  embedding_dimension?: number | null;
  status?: KnowledgeVectorIndexStatus;
  error_message?: string | null;
}

export interface AsyncKnowledgeVectorIndex {
  upsert(input: UpsertKnowledgeVectorIndexInput): Promise<KnowledgeVectorIndexRecord>;
  get(tenantId: string, collection: string, documentId: string, modelId: number): Promise<KnowledgeVectorIndexRecord | null>;
  listForDocument(tenantId: string, documentId: string): Promise<KnowledgeVectorIndexRecord[]>;
  deleteForDocument(tenantId: string, documentId: string): Promise<number>;
  deleteForModel(tenantId: string, modelId: number): Promise<number>;
}
