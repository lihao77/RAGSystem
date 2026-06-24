/**
 * SDK store 表结构 DDL（设计稿 §5）。
 *
 * 只建 SDK 拥有的三张表：messages / run_steps / runs，外加 sessions 占位（messages/runs
 * 的外键父表）。schema 与 backend-ts conversation-store/schema.ts 逐字对齐——同驱动
 * （node:sqlite）、同 WAL/foreign_keys 设置，故 backend-ts 直读同库时表结构兼容。
 *
 * 不建 backend-ts 的 outbox / child_agents / resources / step_resources / session_event_seq：
 * 那些是 backend-ts 衍生能力的表，不在 SDK 视野。SDK 库与 backend-ts 库各自建自己拥有的表即可。
 */

/** SDK 拥有的表 + 索引（幂等）。 */
export const STORE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    thread_key TEXT NOT NULL DEFAULT 'root',
    child_agent_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_session_thread_seq ON messages(session_id, thread_key, seq);

  CREATE TABLE IF NOT EXISTS run_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT,
    step_order INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_run_steps_session_run ON run_steps(session_id, run_id);
  CREATE INDEX IF NOT EXISTS idx_run_steps_message_id ON run_steps(message_id);
  CREATE INDEX IF NOT EXISTS idx_run_steps_session_type_id ON run_steps(session_id, step_type, id DESC);

  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    entrypoint TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    task_summary TEXT,
    user_id TEXT,
    agent_name TEXT,
    thread_key TEXT NOT NULL DEFAULT 'root',
    parent_run_id TEXT,
    parent_call_id TEXT,
    final_message_id TEXT,
    child_agent_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
  CREATE INDEX IF NOT EXISTS idx_runs_session_thread_created ON runs(session_id, thread_key, created_at);

  CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
`;
