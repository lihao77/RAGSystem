export interface PostgresVectorIndexMigration { version: number; name: string; sql: string; }

export const POSTGRES_VECTOR_INDEX_MIGRATIONS: PostgresVectorIndexMigration[] = [{
  version: 1,
  name: "knowledge_vector_index_metadata",
  sql: `
    CREATE TABLE IF NOT EXISTS knowledge_vector_index (
      tenant_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      document_id TEXT NOT NULL,
      model_id BIGINT NOT NULL,
      chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
      embedding_dimension INTEGER CHECK (embedding_dimension IS NULL OR embedding_dimension > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','indexed','failed')),
      error_message TEXT,
      indexed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, collection, document_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS knowledge_vector_index_document_idx
      ON knowledge_vector_index(tenant_id, document_id);
    CREATE INDEX IF NOT EXISTS knowledge_vector_index_model_idx
      ON knowledge_vector_index(tenant_id, model_id);
  `,
}];
