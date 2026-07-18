export interface PostgresOutboxMigration { version: number; name: string; sql: string; }
export const POSTGRES_OUTBOX_MIGRATIONS: PostgresOutboxMigration[] = [{ version: 1, name: "event_outbox", sql: `
CREATE TABLE IF NOT EXISTS session_event_seq (session_id TEXT PRIMARY KEY REFERENCES conversation_sessions(session_id) ON DELETE CASCADE, next_seq BIGINT NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS event_outbox (id BIGSERIAL PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,tenant_id TEXT NOT NULL,run_id TEXT,event_type TEXT NOT NULL,aggregate_type TEXT NOT NULL,aggregate_id TEXT NOT NULL,session_seq BIGINT NOT NULL,payload JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retrying','delivered','failed')),attempts INTEGER NOT NULL DEFAULT 0,available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,locked_at TIMESTAMPTZ,delivered_at TIMESTAMPTZ,last_error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(session_id,session_seq));
CREATE INDEX IF NOT EXISTS event_outbox_pending_idx ON event_outbox(status,available_at,id);
CREATE INDEX IF NOT EXISTS event_outbox_session_seq_idx ON event_outbox(session_id,session_seq);
` }];
