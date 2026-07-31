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
  {
    version: 2,
    name: "artifact_descriptor_and_content",
    sql: `ALTER TABLE artifact_metadata ADD COLUMN IF NOT EXISTS descriptor_path TEXT;
    ALTER TABLE artifact_metadata ADD COLUMN IF NOT EXISTS asset_path TEXT;
    UPDATE artifact_metadata SET descriptor_path=file_path WHERE descriptor_path IS NULL;
    ALTER TABLE artifact_metadata ALTER COLUMN descriptor_path SET NOT NULL;
    ALTER TABLE artifact_metadata DROP COLUMN IF EXISTS file_path;`,
  },
  {
    version: 3,
    name: "artifact_manifest_v2",
    sql: `CREATE TABLE IF NOT EXISTS artifact_metadata_v2 (
      tenant_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subtype TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','failed')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      manifest_path TEXT NOT NULL,
      asset_count INTEGER NOT NULL DEFAULT 0 CHECK (asset_count >= 0),
      presentation_count INTEGER NOT NULL DEFAULT 0 CHECK (presentation_count >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, artifact_id)
    );
    CREATE INDEX IF NOT EXISTS artifact_metadata_v2_session_idx ON artifact_metadata_v2(tenant_id, session_id, created_at ASC);`,
  },
] as const;
