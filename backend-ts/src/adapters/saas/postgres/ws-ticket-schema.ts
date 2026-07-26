export interface PostgresWsTicketMigration { version: number; name: string; sql: string }

export const POSTGRES_WS_TICKET_MIGRATIONS: readonly PostgresWsTicketMigration[] = [{
  version: 1,
  name: "shared-websocket-tickets",
  sql: `
    CREATE TABLE IF NOT EXISTS websocket_tickets (
      ticket_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      permissions JSONB NOT NULL,
      platform_role TEXT,
      widget_app_key TEXT,
      session_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id, session_id)
        REFERENCES conversation_sessions(tenant_id, session_id) ON DELETE CASCADE,
      CHECK (jsonb_typeof(permissions) = 'array')
    );
    CREATE INDEX IF NOT EXISTS websocket_tickets_tenant_expires_idx
      ON websocket_tickets(tenant_id, expires_at);
  `,
}];
