import type { DatabaseSync } from "node:sqlite";

const PLUGIN_ID = "@ragsystem/backend-plugin-scheduler";
const LATEST_VERSION = 1;

/** Install or upgrade the scheduler-owned tables in the shared Local control database. */
export function runSqliteSchedulerMigrations(db: DatabaseSync): void {
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

    CREATE TABLE IF NOT EXISTS scheduler_tasks (
      tenant_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      cron TEXT NOT NULL,
      task TEXT NOT NULL,
      team TEXT,
      entry_agent TEXT,
      session_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      permission_mode TEXT NOT NULL DEFAULT 'relaxed',
      owner_user_id TEXT NOT NULL,
      delivery_channel TEXT,
      delivery_target TEXT,
      delivery_bot_id TEXT,
      next_run REAL,
      last_run REAL,
      last_result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_next_run ON scheduler_tasks(enabled, next_run);
  `);
  migrateBotCronTasks(db);
  db.prepare("INSERT OR IGNORE INTO ragsystem_plugin_schema_migrations(plugin_id, version) VALUES (?, ?)")
    .run(PLUGIN_ID, LATEST_VERSION);
}

/**
 * 一次性搬运 daemon-feishu 旧表 bot_cron_tasks（若存在）：投递目标由
 * push_chat_id / bot 默认 chat 派生，owner 取 bot 用户的 owner_id。
 * INSERT OR IGNORE 天然幂等；旧表保留一个版本周期后由 daemon-feishu 清理。
 */
function migrateBotCronTasks(db: DatabaseSync): void {
  const hasLegacy = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='bot_cron_tasks'",
  ).get();
  if (!hasLegacy) return;
  db.exec(`
    INSERT OR IGNORE INTO scheduler_tasks(
      tenant_id, task_id, cron, task, team, entry_agent, session_id, enabled, permission_mode,
      owner_user_id, delivery_channel, delivery_target, delivery_bot_id, next_run, last_run, last_result,
      created_at, updated_at
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
      CASE WHEN b.enabled = 1 THEN b.next_run ELSE NULL END,
      b.last_run,
      b.last_result,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM bot_cron_tasks b
    JOIN bot_configs bc ON bc.bot_id = b.bot_id
    JOIN users u ON u.id = b.bot_id
    WHERE u.owner_id IS NOT NULL;
  `);
}
