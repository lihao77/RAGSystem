import { runInTransaction } from "./shared/transaction.js";
import { BASELINE_SCHEMA_SQL } from "./schema.js";

export interface MigrationDatabase {
  exec: import("node:sqlite").DatabaseSync["exec"];
  prepare: import("node:sqlite").DatabaseSync["prepare"];
}

export const LATEST_SCHEMA_VERSION = 1;

export function assertVersionsContiguous(migrations: readonly { version: number; name: string }[]): void {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(`migration version gap: expected ${expected}, received ${migration.version} (${migration.name})`);
    }
  });
}

function getUserVersion(db: MigrationDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** No data migration: obsolete development databases must be deleted and recreated. */
export function runMigrations(db: MigrationDatabase): void {
  const current = getUserVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(`Conversation database schema v${current} is obsolete; delete the development database and restart`);
  }
  if (current === LATEST_SCHEMA_VERSION) {
    assertCleanBreakSchema(db);
    return;
  }
  const existing = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name LIMIT 1
  `).get() as { name: string } | undefined;
  if (existing) {
    throw new Error(`Conversation database contains obsolete table '${existing.name}'; delete the development database and restart`);
  }
  runInTransaction(db, () => {
    db.exec(BASELINE_SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
  });
}

function assertCleanBreakSchema(db: MigrationDatabase): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("owner_user_id") || !names.has("origin_type") || !names.has("workspace_id")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
  const goalColumns = db.prepare("PRAGMA table_info(workflow_goals)").all() as unknown as Array<{ name: string }>;
  if (!goalColumns.some((column) => column.name === "continuation_reason")) {
    db.exec("ALTER TABLE workflow_goals ADD COLUMN continuation_reason TEXT");
  }
}
