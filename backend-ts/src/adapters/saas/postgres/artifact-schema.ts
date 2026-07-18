export const POSTGRES_ARTIFACT_MIGRATIONS = [
  {
    version: 1,
    name: "artifact_metadata",
    sql: `CREATE TABLE IF NOT EXISTS artifact_metadata (
      tenant_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      session_id TEXT,
      viz_type TEXT NOT NULL,
      sub_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      file_path TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      mime_type TEXT,
      config JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, artifact_id)
    );
    CREATE INDEX IF NOT EXISTS artifact_metadata_session_idx ON artifact_metadata(tenant_id, session_id, updated_at DESC);`,
  },
] as const;
