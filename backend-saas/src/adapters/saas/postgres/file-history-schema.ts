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
}, {
  version: 2,
  name: "file_history_pending_tracked_seq",
  // 追踪时刻的最大消息 seq（回退门控）：NULL = 历史存量行，rewind 不冲刷、保留给下个快照边界归档。
  sql: `ALTER TABLE file_history_pending ADD COLUMN IF NOT EXISTS tracked_seq BIGINT;`,
}, {
  version: 3,
  name: "file_history_snapshot_seq_bigint",
  // conversation_messages.seq 是跨会话全局 BIGSERIAL，message_seq 与之同域；INTEGER 在
  // 序列越过 2^31 后插入快照即溢出报错。纯类型放宽，无数据变更（读取侧早已 Number() 归一）。
  sql: `ALTER TABLE file_history_snapshots ALTER COLUMN message_seq TYPE BIGINT;`,
}];
