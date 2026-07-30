export interface PostgresOutboxMigration { version: number; name: string; sql: string; }
export const POSTGRES_OUTBOX_MIGRATIONS: PostgresOutboxMigration[] = [{ version: 1, name: "event_outbox", sql: `
CREATE TABLE IF NOT EXISTS session_event_seq (session_id TEXT PRIMARY KEY REFERENCES conversation_sessions(session_id) ON DELETE CASCADE, next_seq BIGINT NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS event_outbox (id BIGSERIAL PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,tenant_id TEXT NOT NULL,run_id TEXT,event_type TEXT NOT NULL,aggregate_type TEXT NOT NULL,aggregate_id TEXT NOT NULL,session_seq BIGINT NOT NULL,payload JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retrying','delivered','failed')),attempts INTEGER NOT NULL DEFAULT 0,available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,locked_at TIMESTAMPTZ,delivered_at TIMESTAMPTZ,last_error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(session_id,session_seq));
CREATE INDEX IF NOT EXISTS event_outbox_pending_idx ON event_outbox(status,available_at,id);
CREATE INDEX IF NOT EXISTS event_outbox_session_seq_idx ON event_outbox(session_id,session_seq);
` }, {
  version: 2,
  name: "delivered-event-notifications",
  sql: `
    CREATE OR REPLACE FUNCTION notify_ragsystem_realtime_event() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM NEW.status THEN
        PERFORM pg_notify(
          'ragsystem_realtime_events',
          json_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id)::text
        );
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS event_outbox_realtime_notify ON event_outbox;
    CREATE TRIGGER event_outbox_realtime_notify
      AFTER UPDATE OF status ON event_outbox
      FOR EACH ROW EXECUTE FUNCTION notify_ragsystem_realtime_event();
  `,
}, {
  version: 3,
  name: "realtime-delivery-sequence",
  sql: `
    CREATE SEQUENCE IF NOT EXISTS event_outbox_delivery_order_seq AS BIGINT;
    ALTER TABLE event_outbox ADD COLUMN IF NOT EXISTS delivery_seq BIGINT;
    UPDATE event_outbox
      SET delivery_seq = nextval('event_outbox_delivery_order_seq')
      WHERE status = 'delivered' AND delivery_seq IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS event_outbox_delivery_seq_idx
      ON event_outbox(delivery_seq) WHERE delivery_seq IS NOT NULL;

    CREATE OR REPLACE FUNCTION notify_ragsystem_realtime_event() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM NEW.status THEN
        PERFORM pg_notify(
          'ragsystem_realtime_events',
          json_build_object(
            'id', NEW.id,
            'tenant_id', NEW.tenant_id,
            'delivery_seq', NEW.delivery_seq
          )::text
        );
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `,
}];
