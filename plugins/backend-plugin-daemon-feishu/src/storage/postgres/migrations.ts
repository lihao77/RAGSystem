import type { Pool, PoolClient } from "pg";

const PLUGIN_ID = "@ragsystem/backend-plugin-daemon-feishu";
const LATEST_VERSION = 1;
const MIGRATION_LOCK_ID = 0x52414746;

/** Install or upgrade the Daemon/Feishu-owned tables in the shared SaaS control database. */
export async function runPostgresDaemonMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ragsystem_plugin_schema_migrations (
        plugin_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (plugin_id, version)
      )
    `);
    await ensureSchema(client);
    await client.query(`
      INSERT INTO ragsystem_plugin_schema_migrations(plugin_id, version)
      VALUES ($1, $2)
      ON CONFLICT (plugin_id, version) DO NOTHING
    `, [PLUGIN_ID, LATEST_VERSION]);
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client, error);
    throw error;
  } finally {
    client.release();
  }
}

async function ensureSchema(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS control_bot_configs (
      bot_id TEXT PRIMARY KEY REFERENCES control_users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES control_tenants(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      team TEXT,
      entry_agent TEXT,
      session_id TEXT,
      default_session_ttl INTEGER NOT NULL DEFAULT 86400 CHECK (default_session_ttl > 0),
      permission_mode TEXT NOT NULL DEFAULT 'relaxed',
      feishu_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      feishu_app_id TEXT,
      feishu_receive_mode TEXT NOT NULL DEFAULT 'webhook' CHECK (feishu_receive_mode IN ('webhook', 'long_connection')),
      route_token_digest TEXT,
      feishu_default_chat_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, bot_id)
    );

    ALTER TABLE control_bot_configs ADD COLUMN IF NOT EXISTS team TEXT;

    CREATE INDEX IF NOT EXISTS control_bot_configs_tenant_idx ON control_bot_configs(tenant_id);
    CREATE INDEX IF NOT EXISTS control_bot_configs_enabled_idx ON control_bot_configs(enabled, feishu_enabled);
    CREATE UNIQUE INDEX IF NOT EXISTS control_bot_configs_route_digest_idx
      ON control_bot_configs(route_token_digest) WHERE route_token_digest IS NOT NULL;

    CREATE TABLE IF NOT EXISTS control_bot_cron_tasks (
      bot_id TEXT NOT NULL REFERENCES control_bot_configs(bot_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      cron TEXT NOT NULL,
      task TEXT NOT NULL,
      entry_agent TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      push_platform TEXT CHECK (push_platform IS NULL OR push_platform = 'feishu'),
      push_chat_id TEXT,
      next_run DOUBLE PRECISION,
      last_run DOUBLE PRECISION,
      last_result TEXT,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at DOUBLE PRECISION,
      last_attempt_id TEXT,
      attempt_count BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (bot_id, task_id)
    );

    ALTER TABLE control_bot_cron_tasks
      ADD COLUMN IF NOT EXISTS lease_owner TEXT,
      ADD COLUMN IF NOT EXISTS lease_token TEXT,
      ADD COLUMN IF NOT EXISTS lease_expires_at DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS last_attempt_id TEXT,
      ADD COLUMN IF NOT EXISTS attempt_count BIGINT NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS control_bot_cron_due_idx ON control_bot_cron_tasks(enabled, next_run);
    CREATE UNIQUE INDEX IF NOT EXISTS control_bot_cron_attempt_idx
      ON control_bot_cron_tasks(last_attempt_id) WHERE last_attempt_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS control_bot_cron_claimable_idx
      ON control_bot_cron_tasks(enabled, next_run, lease_expires_at);
  `);
}

async function rollback(client: PoolClient, error: unknown): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    if (error instanceof Error) error.cause ??= rollbackError;
  }
}
