export interface PostgresPendingInteractionMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_PENDING_INTERACTION_MIGRATIONS: PostgresPendingInteractionMigration[] = [{
  version: 1,
  name: "pending_interactions",
  sql: `
    CREATE TABLE IF NOT EXISTS pending_interactions (
      interaction_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      root_run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('approval', 'user_input')),
      status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'suspended', 'resolved', 'resuming', 'consumed', 'cancelled')),
      request_payload JSONB NOT NULL,
      resolution_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS pending_interactions_session_status_idx
      ON pending_interactions(session_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS pending_interactions_root_batch_idx
      ON pending_interactions(session_id, root_run_id, batch_id, status);
    CREATE INDEX IF NOT EXISTS pending_interactions_tool_idx
      ON pending_interactions(session_id, tool_call_id, status);
  `,
}];
