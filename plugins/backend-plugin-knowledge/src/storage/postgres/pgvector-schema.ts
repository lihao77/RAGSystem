export interface PostgresPgVectorMigration { version: number; name: string; sql: string; }
export const POSTGRES_PGVECTOR_MIGRATIONS: PostgresPgVectorMigration[] = [{ version: 1, name: "knowledge_vector_chunks_pgvector", sql: `
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS knowledge_vector_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, collection TEXT NOT NULL,
      document_id TEXT NOT NULL, model_id BIGINT NOT NULL, chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      content TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, embedding vector NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, collection, document_id, model_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS knowledge_vector_chunks_tenant_model_idx ON knowledge_vector_chunks(tenant_id, collection, model_id);
  ` }, { version: 2, name: "knowledge_vector_chunks_lexical_search", sql: `
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS knowledge_vector_chunks_content_fts_idx
      ON knowledge_vector_chunks USING GIN (to_tsvector('simple'::regconfig, content));
    CREATE INDEX IF NOT EXISTS knowledge_vector_chunks_content_trgm_idx
      ON knowledge_vector_chunks USING GIN (content gin_trgm_ops);
  ` }];
