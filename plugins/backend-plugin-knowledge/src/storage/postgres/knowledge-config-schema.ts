export interface PostgresKnowledgeConfigMigration { version: number; name: string; sql: string; }

export const POSTGRES_KNOWLEDGE_CONFIG_MIGRATIONS: PostgresKnowledgeConfigMigration[] = [{
  version: 1,
  name: "knowledge_vectorizer_config",
  sql: `
    CREATE TABLE IF NOT EXISTS knowledge_vectorizers (
      tenant_id TEXT NOT NULL,
      model_id BIGSERIAL PRIMARY KEY,
      vectorizer_key TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      provider_type TEXT,
      model_name TEXT NOT NULL,
      distance_metric TEXT NOT NULL DEFAULT 'cosine',
      vector_dimension INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (tenant_id, vectorizer_key),
      CHECK (vector_dimension IS NULL OR vector_dimension > 0)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_vectorizers_active_idx
      ON knowledge_vectorizers(tenant_id) WHERE is_active;
  `,
}, {
  version: 2,
  name: "knowledge_reranker_config",
  sql: `
    CREATE TABLE IF NOT EXISTS knowledge_rerankers (
      tenant_id TEXT NOT NULL,
      reranker_key TEXT NOT NULL,
      mode TEXT NOT NULL,
      provider_key TEXT NOT NULL DEFAULT '',
      provider_type TEXT,
      model_name TEXT NOT NULL DEFAULT '',
      api_endpoint TEXT NOT NULL DEFAULT '',
      api_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (tenant_id, reranker_key),
      CHECK (mode IN ('model', 'lexical', 'none'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_rerankers_active_idx
      ON knowledge_rerankers(tenant_id) WHERE is_active;
  `,
}];
