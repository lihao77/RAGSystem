import type { PostgresExecutor } from './postgres-executor.js';

/** Permanent shape guard for fresh, restored and partially initialized databases. */
export async function hydrateMessageRequestSchema(executor: PostgresExecutor): Promise<void> {
  await executor.query(`CREATE TABLE IF NOT EXISTS session_message_requests (
    session_id TEXT NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unknown',
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(session_id, request_id)
  );
  ALTER TABLE session_message_requests ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_message_requests ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unknown';
  ALTER TABLE session_message_requests ADD COLUMN IF NOT EXISTS error TEXT;
  ALTER TABLE session_message_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
  CREATE INDEX IF NOT EXISTS conversation_messages_root_request_idx
    ON conversation_messages(session_id, (metadata->>'request_id')) WHERE role='user' AND thread_key='root';
  CREATE OR REPLACE FUNCTION consume_message_request() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE session_message_requests SET status='consumed', error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE session_id=NEW.session_id AND request_id=NEW.metadata->>'request_id';
    RETURN NEW;
  END;
  $$;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='conversation_messages_consume_request'
      AND tgrelid='conversation_messages'::regclass) THEN
      CREATE TRIGGER conversation_messages_consume_request AFTER INSERT OR UPDATE OF metadata, role, thread_key ON conversation_messages
        FOR EACH ROW WHEN (NEW.role='user' AND NEW.thread_key='root' AND jsonb_typeof(NEW.metadata->'request_id')='string')
        EXECUTE FUNCTION consume_message_request();
    END IF;
  END $$;`);
}
