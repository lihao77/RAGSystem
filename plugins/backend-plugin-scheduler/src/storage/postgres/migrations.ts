import type { Pool, PoolClient } from "pg";

const PLUGIN_ID = "@ragsystem/backend-plugin-scheduler";

/** Install or upgrade the scheduler-owned tables in the shared SaaS control database. */
export async function runPostgresSchedulerMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(0x52414747)");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ragsystem_plugin_schema_migrations (
          plugin_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (plugin_id, version)
        );

        CREATE TABLE IF NOT EXISTS control_scheduler_tasks (
          tenant_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          cron TEXT NOT NULL,
          task TEXT NOT NULL,
          team TEXT,
          entry_agent TEXT,
          session_id TEXT,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          permission_mode TEXT NOT NULL DEFAULT 'relaxed',
          owner_user_id TEXT NOT NULL,
          delivery_channel TEXT,
          delivery_target TEXT,
          delivery_bot_id TEXT,
          next_run DOUBLE PRECISION,
          last_run DOUBLE PRECISION,
          last_result TEXT,
          lease_owner TEXT,
          lease_token TEXT,
          lease_expires_at DOUBLE PRECISION,
          last_attempt_id TEXT,
          attempt_count BIGINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (tenant_id, task_id)
        );

        CREATE INDEX IF NOT EXISTS control_scheduler_due_idx ON control_scheduler_tasks(enabled, next_run);
        CREATE UNIQUE INDEX IF NOT EXISTS control_scheduler_attempt_idx
          ON control_scheduler_tasks(last_attempt_id) WHERE last_attempt_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS control_scheduler_claimable_idx
          ON control_scheduler_tasks(enabled, next_run, lease_expires_at);
      `);
      await migrateBotCronTasks(client);
      await client.query(
        "INSERT INTO ragsystem_plugin_schema_migrations(plugin_id, version) VALUES ($1, 1) ON CONFLICT DO NOTHING",
        [PLUGIN_ID],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

/** 一次性搬运 daemon-feishu 旧表（若存在）；ON CONFLICT DO NOTHING 天然幂等。 */
async function migrateBotCronTasks(client: PoolClient): Promise<void> {
  const legacy = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='control_bot_cron_tasks') AS exists",
  );
  if (!legacy.rows[0]?.exists) return;
  await client.query(`
    INSERT INTO control_scheduler_tasks(
      tenant_id, task_id, cron, task, team, entry_agent, session_id, enabled, permission_mode,
      owner_user_id, delivery_channel, delivery_target, delivery_bot_id, next_run, last_run, last_result
    )
    SELECT
      bc.tenant_id,
      b.task_id,
      b.cron,
      b.task,
      bc.team,
      COALESCE(b.entry_agent, bc.entry_agent),
      bc.session_id,
      b.enabled,
      bc.permission_mode,
      u.owner_id,
      'feishu',
      COALESCE(b.push_chat_id, bc.feishu_default_chat_id),
      b.bot_id,
      CASE WHEN b.enabled THEN b.next_run ELSE NULL END,
      b.last_run,
      b.last_result
    FROM control_bot_cron_tasks b
    JOIN control_bot_configs bc ON bc.bot_id = b.bot_id
    JOIN control_users u ON u.id = b.bot_id
    WHERE u.owner_id IS NOT NULL
    ON CONFLICT (tenant_id, task_id) DO NOTHING
  `);
}
