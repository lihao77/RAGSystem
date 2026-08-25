import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { runSqliteSchedulerMigrations } from '../dist/storage/local/sqlite-migrations.js'
import { SqliteSchedulerTaskStore } from '../dist/storage/local/sqlite-task-store.js'

function createLegacySchema(db) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      created_at TEXT,
      username TEXT, password_hash TEXT, platform_role TEXT, status TEXT, type TEXT, owner_id TEXT
    );
    CREATE TABLE memberships (user_id TEXT, tenant_id TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE bot_configs (
      bot_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      team TEXT, entry_agent TEXT, session_id TEXT,
      default_session_ttl INTEGER NOT NULL DEFAULT 86400,
      permission_mode TEXT NOT NULL DEFAULT 'relaxed',
      feishu_app_id TEXT, feishu_app_secret TEXT, feishu_token TEXT, feishu_encoding_aes_key TEXT,
      feishu_receive_mode TEXT NOT NULL DEFAULT 'webhook', feishu_route_token TEXT, feishu_default_chat_id TEXT,
      feishu_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE bot_cron_tasks (
      bot_id TEXT NOT NULL, task_id TEXT NOT NULL,
      cron TEXT NOT NULL, task TEXT NOT NULL, entry_agent TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, push_platform TEXT, push_chat_id TEXT,
      next_run REAL, last_run REAL, last_result TEXT,
      PRIMARY KEY (bot_id, task_id)
    );
  `)
  db.prepare("INSERT INTO users(id, display_name, created_at, status, type, owner_id) VALUES ('usr_bot1', 'bot', '2026-01-01', 'active', 'bot', 'usr_owner1')").run()
  db.prepare("INSERT INTO tenants(id) VALUES ('tnt_a')").run()
  db.prepare("INSERT INTO bot_configs(bot_id, tenant_id, team, entry_agent, session_id, feishu_default_chat_id, created_at, updated_at) VALUES ('usr_bot1', 'tnt_a', 'team-x', 'main', NULL, 'oc_default', '2026-01-01', '2026-01-01')").run()
  db.prepare("INSERT INTO bot_cron_tasks(bot_id, task_id, cron, task, entry_agent, enabled, push_platform, push_chat_id, next_run, last_run, last_result) VALUES ('usr_bot1', 'daily', '0 9 * * *', '早报', NULL, 1, 'feishu', 'oc_push', 100.5, 90.5, 'ok')").run()
  db.prepare("INSERT INTO bot_cron_tasks(bot_id, task_id, cron, task, entry_agent, enabled, push_platform, push_chat_id, next_run, last_run, last_result) VALUES ('usr_bot1', 'weekly', '0 9 * * 1', '周报', 'reporter', 1, NULL, NULL, NULL, NULL, NULL)").run()
}

test('scheduler migration carries bot cron tasks over with feishu delivery and is idempotent', async () => {
  const db = new DatabaseSync(':memory:')
  createLegacySchema(db)

  runSqliteSchedulerMigrations(db)
  const store = new SqliteSchedulerTaskStore(db)
  const tasks = await store.listTasks('tnt_a')
  assert.equal(tasks.length, 2)

  const daily = tasks.find((task) => task.task_id === 'daily')
  assert.ok(daily)
  assert.equal(daily.owner_user_id, 'usr_owner1')
  assert.equal(daily.team, 'team-x')
  assert.equal(daily.entry_agent, 'main')
  assert.deepEqual(daily.delivery, { channel: 'feishu', target: 'oc_push', bot_id: 'usr_bot1' })
  assert.equal(daily.next_run, 100.5)
  assert.equal(daily.last_result, 'ok')

  const weekly = tasks.find((task) => task.task_id === 'weekly')
  assert.ok(weekly)
  assert.equal(weekly.entry_agent, 'reporter', '任务级 entry_agent 优先于 bot 默认')
  assert.deepEqual(weekly.delivery, { channel: 'feishu', target: 'oc_default', bot_id: 'usr_bot1' }, '无 push_chat_id 时回退 bot 默认 chat')

  // 幂等：重复执行迁移不产生重复行
  runSqliteSchedulerMigrations(db)
  assert.equal((await store.listTasks('tnt_a')).length, 2)

  // 无旧表（全新安装）时迁移静默跳过
  const fresh = new DatabaseSync(':memory:')
  runSqliteSchedulerMigrations(fresh)
  assert.equal((await new SqliteSchedulerTaskStore(fresh).listTasks('tnt_a')).length, 0)
})

test('sqlite task store claim dedupes in-flight leases and releases on completion', async () => {
  const db = new DatabaseSync(':memory:')
  runSqliteSchedulerMigrations(db)
  const store = new SqliteSchedulerTaskStore(db)
  await store.createTask('tnt_a', 'usr_owner1', {
    task_id: 'due', cron: '* * * * *', task: '内容', enabled: true, next_run: 1,
  })

  const now = 1000
  const first = await store.claimDueTasks({ now, leaseOwner: 'owner-a' })
  assert.equal(first.length, 1)
  const second = await store.claimDueTasks({ now: now + 1, leaseOwner: 'owner-b' })
  assert.equal(second.length, 0, '租约期内不得重复认领')

  const expired = await store.claimDueTasks({ now: now + 301, leaseOwner: 'owner-b' })
  assert.equal(expired.length, 1, '租约过期后允许再次认领')

  assert.equal(await store.completeTaskClaim({ tenantId: 'tnt_a', taskId: 'due', claimToken: expired[0].claimToken }), true)
  assert.equal(await store.completeTaskClaim({ tenantId: 'tnt_a', taskId: 'due', claimToken: 'bad-token' }), false)
})
