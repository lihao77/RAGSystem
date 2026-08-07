import { runInTransaction } from "./shared/transaction.js";
import { BASELINE_SCHEMA_SQL } from "./schema.js";

export interface MigrationDatabase {
  exec: import("node:sqlite").DatabaseSync["exec"];
  prepare: import("node:sqlite").DatabaseSync["prepare"];
}

export const LATEST_SCHEMA_VERSION = 4;

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

/** Applies explicit schema versions only; historical session data is never repaired here. */
export function runMigrations(db: MigrationDatabase): void {
  const current = getUserVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(`Conversation database schema v${current} is obsolete; delete the development database and restart`);
  }
  if (current === LATEST_SCHEMA_VERSION) {
    assertCurrentSchema(db);
    return;
  }
  if (current === 1 || current === 2 || current === 3) {
    assertVersionOneSchema(db);
    runInTransaction(db, () => {
      if (current === 1) db.exec("ALTER TABLE runs ADD COLUMN terminal_reason TEXT");
      if (current <= 2) db.exec("ALTER TABLE workspaces ADD COLUMN removed_at TIMESTAMP");
      db.exec(`
        DELETE FROM workspaces
        WHERE removed_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM sessions
            WHERE sessions.tenant_id=workspaces.tenant_id
              AND sessions.workspace_id=workspaces.workspace_id
          )
      `);
      db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
    });
    assertCurrentSchema(db);
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

function assertVersionOneSchema(db: MigrationDatabase): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("owner_user_id") || !names.has("origin_type") || !names.has("workspace_id")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
  const goalColumns = db.prepare("PRAGMA table_info(workflow_goals)").all() as unknown as Array<{ name: string }>;
  if (!goalColumns.some((column) => column.name === "continuation_reason")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
}

function assertCurrentSchema(db: MigrationDatabase): void {
  assertVersionOneSchema(db);
  const runColumns = db.prepare("PRAGMA table_info(runs)").all() as unknown as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "terminal_reason")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
  const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as unknown as Array<{ name: string }>;
  if (!workspaceColumns.some((column) => column.name === "removed_at")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
}
