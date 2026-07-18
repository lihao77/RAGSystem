export interface PostgresConversationMigration { version: number; name: string; sql: string; }

export const POSTGRES_CONVERSATION_MIGRATIONS: PostgresConversationMigration[] = [{
  version: 1,
  name: "conversation_sessions_messages",
  sql: `
    CREATE TABLE IF NOT EXISTS conversation_sessions (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT,
      permission_mode TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS conversation_sessions_tenant_updated_idx
      ON conversation_sessions(tenant_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS conversation_sessions_tenant_user_idx
      ON conversation_sessions(tenant_id, user_id);
    CREATE TABLE IF NOT EXISTS conversation_messages (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      session_id TEXT NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
      content TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      thread_key TEXT NOT NULL DEFAULT 'root',
      child_agent_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS conversation_messages_session_seq_idx
      ON conversation_messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS conversation_messages_session_thread_seq_idx
      ON conversation_messages(session_id, thread_key, seq);
  `,
}, {
  version: 2,
  name: "provider_continuations",
  sql: `
    ALTER TABLE conversation_sessions
      ADD CONSTRAINT conversation_sessions_tenant_session_unique
      UNIQUE (tenant_id, session_id);
    ALTER TABLE conversation_messages
      ADD CONSTRAINT conversation_messages_session_message_unique
      UNIQUE (session_id, id);
    CREATE TABLE provider_continuations (
      tenant_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      tool_call_ids JSONB NOT NULL,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, message_id),
      FOREIGN KEY (tenant_id, session_id)
        REFERENCES conversation_sessions(tenant_id, session_id) ON DELETE CASCADE,
      FOREIGN KEY (session_id, message_id)
        REFERENCES conversation_messages(session_id, id) ON DELETE CASCADE,
      CHECK (jsonb_typeof(tool_call_ids) = 'array')
    );
    CREATE INDEX provider_continuations_tenant_session_thread_idx
      ON provider_continuations(tenant_id, session_id, thread_key, created_at);
  `,
}];
