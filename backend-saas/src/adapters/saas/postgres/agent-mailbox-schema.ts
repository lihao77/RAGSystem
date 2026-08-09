export interface PostgresAgentMailboxMigration {
  version: number;
  name: string;
  sql: string;
}

/** Durable Agent-to-Agent mailbox schema, kept separate from chat history. */
export const POSTGRES_AGENT_MAILBOX_MIGRATIONS: PostgresAgentMailboxMigration[] = [{
  version: 1,
  name: "agent_mailbox_messages",
  sql: `
    CREATE TABLE agent_mailbox_messages (
      seq BIGSERIAL NOT NULL,
      message_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_run_id TEXT,
      source_agent_call_id TEXT,
      target_run_id TEXT,
      target_agent_call_id TEXT,
      target_thread_key TEXT NOT NULL,
      target_child_agent_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('progress','request','response','result','cancel')),
      correlation_id TEXT,
      reply_to_message_id TEXT,
      content_parts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(content_parts) = 'array'),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','acked','expired')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      claim_id TEXT,
      claimed_by TEXT,
      claim_expires_at TIMESTAMPTZ,
      available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      acked_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, message_id),
      FOREIGN KEY (tenant_id, session_id)
        REFERENCES conversation_sessions(tenant_id, session_id) ON DELETE CASCADE
    );
    CREATE INDEX agent_mailbox_target_run_idx
      ON agent_mailbox_messages(tenant_id, session_id, target_run_id, status, available_at, seq);
    CREATE INDEX agent_mailbox_target_thread_idx
      ON agent_mailbox_messages(tenant_id, session_id, target_thread_key, target_child_agent_id, status, available_at, seq);
    CREATE INDEX agent_mailbox_claim_expiry_idx
      ON agent_mailbox_messages(tenant_id, status, claim_expires_at);
    CREATE INDEX agent_mailbox_correlation_idx
      ON agent_mailbox_messages(tenant_id, session_id, correlation_id, seq);
  `,
}];
