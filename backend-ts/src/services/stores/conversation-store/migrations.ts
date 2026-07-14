import { runInTransaction } from "./shared/transaction.js";
import { BASELINE_SCHEMA_SQL } from "./schema.js";
import { widgetUserId } from "../../../identity/widget-user-id.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../identity/local-identity-provider.js";

export interface MigrationDatabase {
  exec: import("node:sqlite").DatabaseSync["exec"];
  prepare: import("node:sqlite").DatabaseSync["prepare"];
}

/**
 * 单个 schema 迁移。version 从 1 起严格递增、连续；up 内只写本版相对上一版的增量 DDL。
 * 迁移一经发布即不可变更——需修正只能追加新版本,禁止回改历史迁移体（否则存量库与新库 schema 漂移）。
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: MigrationDatabase) => void;
}

/**
 * 有序迁移表。新增 schema 变更 = 在末尾追加一项 version=N+1,绝不修改既有项。
 * v1 为基线:整库 schema(IF NOT EXISTS,对存量库幂等),把 user_version=0 的旧库纳入版本体系。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "baseline",
    up: (db) => {
      db.exec(BASELINE_SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: "agent_call_metrics",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_call_metrics (
          metric_id TEXT PRIMARY KEY,
          agent_name TEXT NOT NULL,
          session_id TEXT,
          run_id TEXT,
          task_id TEXT,
          execution_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          token_in INTEGER NOT NULL DEFAULT 0,
          token_out INTEGER NOT NULL DEFAULT 0,
          tool_usage TEXT NOT NULL DEFAULT '{}',
          error_type TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_call_metrics_agent_started
          ON agent_call_metrics(agent_name, started_at);
      `);
    },
  },
  {
    version: 3,
    name: "agent_call_metrics_model",
    up: (db) => {
      // 补 model 列供"模型用量"维度聚合。历史行 model 为 NULL,聚合 COALESCE 归"未知"桶。
      // 新库经 v2 建表后亦经此 ALTER 补列,新老库收敛一致。
      db.exec(`ALTER TABLE agent_call_metrics ADD COLUMN model TEXT;`);
    },
  },
  {
    version: 4,
    name: "message_record_kind_unify",
    up: (db) => {
      // 收敛 message 记录语义类型到 metadata.msg_type:把散落的 metadata.type(command/
      // command_result)与 metadata.compression 回填进 msg_type 并清除老字段,新老库同走此迁移。
      db.exec(`
        UPDATE messages SET metadata = json_remove(json_set(metadata, '$.msg_type', 'command_result'), '$.type')
          WHERE json_extract(metadata, '$.type') = 'command_result';
        UPDATE messages SET metadata = json_remove(json_set(metadata, '$.msg_type', 'command'), '$.type')
          WHERE json_extract(metadata, '$.type') = 'command';
        UPDATE messages SET metadata = json_remove(json_set(metadata, '$.msg_type', 'context_compression_summary'), '$.compression')
          WHERE json_extract(metadata, '$.compression') = 1 AND json_extract(metadata, '$.msg_type') IS NULL;
        UPDATE messages SET metadata = json_remove(metadata, '$.compression')
          WHERE json_extract(metadata, '$.msg_type') = 'context_compression_summary';
      `);
    },
  },
  {
    version: 5,
    name: "execution_envelope_only",
    up: (db) => {
      // 旧 execution.step 不再受支持。升级后历史执行树只认 protocol.envelope.v1；
      // 老步骤直接删除，并标记对应消息不再提供执行历史，避免 UI 展示空树入口。
      db.exec(`
        UPDATE messages
        SET metadata = json_set(COALESCE(metadata, '{}'), '$.execution_history_discarded', json('true'))
        WHERE EXISTS (
          SELECT 1
          FROM run_steps AS legacy
          WHERE legacy.step_type = 'execution.step'
            AND legacy.session_id = messages.session_id
            AND legacy.run_id = json_extract(messages.metadata, '$.run_id')
            AND NOT EXISTS (
              SELECT 1 FROM run_steps AS archived
              WHERE archived.run_id = legacy.run_id
                AND archived.session_id = legacy.session_id
                AND archived.step_type = 'protocol.envelope.v1'
            )
        );
        DELETE FROM run_steps WHERE step_type = 'execution.step';
      `);
    },
  },
  {
    version: 6,
    name: "runs_request_id",
    up: (db) => {
      db.exec(`ALTER TABLE runs ADD COLUMN request_id TEXT;`);
    },
  },
  {
    version: 7,
    name: "session_tenant_ownership",
    up: (db) => {
      addColumnIfMissing(db, "sessions", "tenant_id", "TEXT");
      addColumnIfMissing(db, "runs", "tenant_id", "TEXT");
      addColumnIfMissing(db, "event_outbox", "tenant_id", "TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_tenant_updated ON sessions(tenant_id, updated_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_runs_tenant_session ON runs(tenant_id, session_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_event_outbox_tenant_status ON event_outbox(tenant_id, status, available_at, id)");
    },
  },
  {
    version: 8,
    name: "private_session_owners",
    up: (db) => {
      const widgetRows = db
        .prepare("SELECT session_id, user_id FROM sessions WHERE user_id LIKE 'widget%'")
        .all() as unknown as Array<{ session_id: string; user_id: string }>;
      const invalid = widgetRows.filter((row) => !row.user_id.startsWith("widget:") || !row.user_id.slice(7).trim());
      if (invalid.length > 0) {
        const report = invalid.map((row) => `${row.session_id}=${row.user_id}`).join(", ");
        throw new Error(`v8 无法解析历史 widget owner: ${report}`);
      }
      const updateSessionOwner = db.prepare("UPDATE sessions SET user_id=? WHERE session_id=?");
      const updateRunOwner = db.prepare("UPDATE runs SET user_id=? WHERE session_id=?");
      for (const row of widgetRows) {
        const ownerId = widgetUserId(row.user_id.slice(7));
        updateSessionOwner.run(ownerId, row.session_id);
        updateRunOwner.run(ownerId, row.session_id);
      }
      db.prepare("UPDATE sessions SET user_id=? WHERE tenant_id=? AND user_id IS NULL")
        .run(LOCAL_USER_ID, LOCAL_TENANT_ID);
      db.prepare(`
        UPDATE runs
        SET user_id=?
        WHERE session_id IN (
          SELECT session_id FROM sessions WHERE tenant_id=? AND user_id=?
        )
      `).run(LOCAL_USER_ID, LOCAL_TENANT_ID, LOCAL_USER_ID);
    },
  },
];

function addColumnIfMissing(db: MigrationDatabase, table: string, column: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

function getUserVersion(db: MigrationDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * 按 user_version 游标顺序应用所有未执行迁移,每个迁移 + 版本号推进同处一个事务(原子:要么整版生效要么回滚)。
 * 替代裸 CREATE TABLE IF NOT EXISTS——存量库与新库经同一条迁移链收敛到 LATEST_SCHEMA_VERSION。
 * 注:PRAGMA user_version=? 不支持参数绑定,版本号经 Number() 后内联,无注入面。
 */
export function runMigrations(db: MigrationDatabase): void {
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  assertVersionsContiguous(ordered);
  const current = getUserVersion(db);
  for (const migration of ordered) {
    if (migration.version <= current) {
      continue;
    }
    runInTransaction(db, () => {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
    });
  }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export function assertVersionsContiguous(ordered: readonly Migration[]): void {
  ordered.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `migration version 不连续:位置 ${index} 期望 version=${expected},实际 ${migration.version}(${migration.name})`,
      );
    }
  });
}
