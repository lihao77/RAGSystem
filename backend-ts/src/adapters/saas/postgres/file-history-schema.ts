export interface PostgresFileHistoryMigration { version: number; name: string; sql: string }

export const POSTGRES_FILE_HISTORY_MIGRATIONS: PostgresFileHistoryMigration[] = [{
  version: 1,
  name: "file_history_metadata",
  sql: `
    CREATE TABLE IF NOT EXISTS file_history_pending (
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      file_key TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('modified', 'created')),
      backup_hash TEXT,
      content_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, session_id, file_key),
      CHECK ((action = 'modified' AND backup_hash ~ '^[a-f0-9]{64}$') OR (action = 'created' AND backup_hash IS NULL))
    );
    CREATE TABLE IF NOT EXISTS file_history_snapshots (
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      message_seq INTEGER NOT NULL,
      tracked_files JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, session_id, snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS file_history_snapshots_session_seq_idx
      ON file_history_snapshots(tenant_id, session_id, message_seq);
  `,
}];
