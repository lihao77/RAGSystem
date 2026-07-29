import type { DatabaseSync } from "node:sqlite";

const PLUGIN_ID = "@ragsystem/backend-plugin-daemon-feishu";
const LATEST_VERSION = 1;

/** Install or upgrade the Daemon/Feishu-owned tables in the shared Local control database. */
export function runSqliteDaemonMigrations(db: DatabaseSync): void {
  if (db.isTransaction) {
    migrate(db);
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    migrate(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ragsystem_plugin_schema_migrations (
      plugin_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (plugin_id, version)
    );

    CREATE TABLE IF NOT EXISTS bot_configs (
      bot_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      team TEXT,
      entry_agent TEXT,
      session_id TEXT,
      default_session_ttl INTEGER NOT NULL DEFAULT 86400,
      permission_mode TEXT NOT NULL DEFAULT 'relaxed',
      feishu_app_id TEXT,
      feishu_app_secret TEXT,
      feishu_token TEXT,
      feishu_encoding_aes_key TEXT,
      feishu_receive_mode TEXT NOT NULL DEFAULT 'webhook',
      feishu_route_token TEXT,
      feishu_default_chat_id TEXT,
      feishu_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (bot_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_bot_configs_tenant_id ON bot_configs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_bot_configs_feishu_enabled ON bot_configs(feishu_enabled);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_configs_feishu_route_token
      ON bot_configs(feishu_route_token) WHERE feishu_route_token IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bot_cron_tasks (
      bot_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      cron TEXT NOT NULL,
      task TEXT NOT NULL,
      entry_agent TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      push_platform TEXT,
      push_chat_id TEXT,
      next_run REAL,
      last_run REAL,
      last_result TEXT,
      PRIMARY KEY (bot_id, task_id),
      FOREIGN KEY (bot_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_bot_cron_tasks_next_run ON bot_cron_tasks(enabled, next_run);
  `);
  ensureColumn(db, "bot_configs", "permission_mode", "TEXT NOT NULL DEFAULT 'relaxed'");
  ensureColumn(db, "bot_configs", "feishu_default_chat_id", "TEXT");
  ensureColumn(db, "bot_configs", "team", "TEXT");
  db.exec(`
    INSERT OR IGNORE INTO bot_configs(
      bot_id, tenant_id, enabled, team, entry_agent, session_id, default_session_ttl, permission_mode,
      feishu_app_id, feishu_app_secret, feishu_token, feishu_encoding_aes_key,
      feishu_receive_mode, feishu_route_token, feishu_default_chat_id, feishu_enabled, created_at, updated_at
    )
    SELECT u.id, MIN(m.tenant_id), 0, NULL, NULL, NULL, 86400, 'relaxed',
      NULL, NULL, NULL, NULL, 'webhook', NULL, NULL, 0, u.created_at, u.created_at
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    WHERE u.type = 'bot'
    GROUP BY u.id;
  `);
  db.prepare("INSERT OR IGNORE INTO ragsystem_plugin_schema_migrations(plugin_id, version) VALUES (?, ?)")
    .run(PLUGIN_ID, LATEST_VERSION);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
