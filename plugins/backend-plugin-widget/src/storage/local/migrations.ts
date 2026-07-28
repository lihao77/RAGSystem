import type { WidgetCredentialDb } from "./widget-credential-store/db.js";

export function runSqliteWidgetMigrations(db: WidgetCredentialDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS widget_apps (
      app_key TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      secret_prefix TEXT NOT NULL,
      display_name TEXT NOT NULL,
      allowed_origins TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_widget_apps_tenant_id ON widget_apps(tenant_id);
    CREATE TABLE IF NOT EXISTS widget_tokens (
      jti TEXT PRIMARY KEY,
      app_key TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (app_key) REFERENCES widget_apps(app_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_widget_tokens_app_key ON widget_tokens(app_key);
    CREATE INDEX IF NOT EXISTS idx_widget_tokens_expires_at ON widget_tokens(expires_at);
    CREATE TABLE IF NOT EXISTS widget_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_key TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (app_key) REFERENCES widget_apps(app_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_widget_audit_app_key ON widget_audit(app_key, id DESC);
  `);
}
