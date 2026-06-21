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
