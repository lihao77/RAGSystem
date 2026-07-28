import type { Pool } from "pg";

export async function runPostgresWidgetMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_widget_apps (
      app_key TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES control_tenants(id) ON DELETE CASCADE,
      secret_hash TEXT NOT NULL,
      secret_prefix TEXT NOT NULL,
      display_name TEXT NOT NULL,
      allowed_origins TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS control_widget_apps_tenant_idx ON control_widget_apps(tenant_id);
    CREATE TABLE IF NOT EXISTS control_widget_tokens (
      jti TEXT PRIMARY KEY,
      app_key TEXT NOT NULL REFERENCES control_widget_apps(app_key) ON DELETE CASCADE,
      issued_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS control_widget_tokens_app_idx ON control_widget_tokens(app_key, issued_at DESC);
    CREATE INDEX IF NOT EXISTS control_widget_tokens_expiry_idx ON control_widget_tokens(expires_at);
    CREATE TABLE IF NOT EXISTS control_widget_audit (
      id BIGSERIAL PRIMARY KEY,
      app_key TEXT NOT NULL REFERENCES control_widget_apps(app_key) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS control_widget_audit_app_idx ON control_widget_audit(app_key, id DESC);
  `);
}
