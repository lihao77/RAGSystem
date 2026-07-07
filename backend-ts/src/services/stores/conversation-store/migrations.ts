import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { BASELINE_SCHEMA_SQL } from "./schema.js";

/**
 * 单个 schema 迁移。version 从 1 起严格递增、连续；up 内只写本版相对上一版的增量 DDL。
 * 迁移一经发布即不可变更——需修正只能追加新版本,禁止回改历史迁移体（否则存量库与新库 schema 漂移）。
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: ConversationDb) => void;
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
];

function getUserVersion(db: ConversationDb): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * 按 user_version 游标顺序应用所有未执行迁移,每个迁移 + 版本号推进同处一个事务(原子:要么整版生效要么回滚)。
 * 替代裸 CREATE TABLE IF NOT EXISTS——存量库与新库经同一条迁移链收敛到 LATEST_SCHEMA_VERSION。
 * 注:PRAGMA user_version=? 不支持参数绑定,版本号经 Number() 后内联,无注入面。
 */
export function runMigrations(db: ConversationDb): void {
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

function assertVersionsContiguous(ordered: readonly Migration[]): void {
  ordered.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `migration version 不连续:位置 ${index} 期望 version=${expected},实际 ${migration.version}(${migration.name})`,
      );
    }
  });
}
