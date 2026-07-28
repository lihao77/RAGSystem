export interface PostgresSessionFileMigration { version: number; name: string; sql: string }

export const POSTGRES_SESSION_FILE_MIGRATIONS: PostgresSessionFileMigration[] = [{
  version: 1,
  name: "session_file_metadata",
  sql: `
    CREATE TABLE IF NOT EXISTS session_files (
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      size BIGINT NOT NULL CHECK (size >= 0),
      mime TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      uploaded_by TEXT,
      indexed_in_vector BOOLEAN NOT NULL DEFAULT FALSE,
      tags TEXT,
      notes TEXT,
      PRIMARY KEY (tenant_id, id),
      UNIQUE (tenant_id, storage_key)
    );
    CREATE INDEX IF NOT EXISTS session_files_tenant_session_idx
      ON session_files(tenant_id, session_id, uploaded_at DESC);
  `,
}];
