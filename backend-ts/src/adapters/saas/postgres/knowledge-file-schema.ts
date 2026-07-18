export interface PostgresKnowledgeFileMigration { version: number; name: string; sql: string; }

export const POSTGRES_KNOWLEDGE_FILE_MIGRATIONS: PostgresKnowledgeFileMigration[] = [{
  version: 1,
  name: "knowledge_file_metadata",
  sql: `
    CREATE TABLE IF NOT EXISTS knowledge_files (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      size BIGINT NOT NULL CHECK (size >= 0),
      mime TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      md_blob_hash TEXT,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS knowledge_files_tenant_uploaded_idx
      ON knowledge_files(tenant_id, uploaded_at DESC);
  `,
}];
