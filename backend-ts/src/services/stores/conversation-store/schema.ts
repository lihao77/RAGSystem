/**
 * 基线 schema（迁移 v1）。
 * 全部 CREATE 用 IF NOT EXISTS,对存量库幂等——故可安全作为 user_version=0→1 的基线迁移体。
 * 后续 schema 演进一律新增 migrations.ts 中的迁移项,不再改动本常量。
 */
export const BASELINE_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

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

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tenant_id TEXT,
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

    CREATE TABLE IF NOT EXISTS resources (
      resource_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT,
      step_id INTEGER,
      message_id TEXT,
      resource_type TEXT NOT NULL,
      sub_type TEXT,
      title TEXT,
      path TEXT NOT NULL,
      source_tool TEXT,
      scope TEXT NOT NULL DEFAULT 'transient',
      metadata TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS step_resources (
      step_id INTEGER NOT NULL,
      resource_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT,
      PRIMARY KEY(step_id, resource_id)
    );

    CREATE TABLE IF NOT EXISTS child_agents (
      child_agent_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_seq INTEGER,
      created_by_run_id TEXT,
      created_by_call_id TEXT,
      parent_run_id TEXT,
      parent_call_id TEXT,
      last_run_id TEXT,
      metadata TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS session_event_seq (
      session_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS event_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL,
      tenant_id TEXT,
      run_id TEXT,
      session_seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      locked_at TIMESTAMP,
      delivered_at TIMESTAMP,
      last_error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_run_steps_session_run ON run_steps(session_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_run_steps_message_id ON run_steps(message_id);
    CREATE INDEX IF NOT EXISTS idx_run_steps_session_type_id ON run_steps(session_id, step_type, id DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_runs_session_thread_created ON runs(session_id, thread_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_resources_session_run ON resources(session_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_child_agents_session_created ON child_agents(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_child_agents_session_agent ON child_agents(session_id, agent_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_child_agents_session_thread ON child_agents(session_id, thread_key);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_pending ON event_outbox(status, available_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_outbox_session_seq ON event_outbox(session_id, session_seq);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_run_seq ON event_outbox(run_id, session_seq);
  `;
