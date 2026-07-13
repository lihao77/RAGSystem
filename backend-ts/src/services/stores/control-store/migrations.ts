import { assertVersionsContiguous } from "../conversation-store/migrations.js";
import { runInTransaction } from "../conversation-store/shared/transaction.js";
import { CONTROL_BASELINE_SCHEMA_SQL, CONTROL_WIDGET_SCHEMA_SQL } from "./schema.js";

export interface ControlMigrationDatabase {
  exec: import("node:sqlite").DatabaseSync["exec"];
  prepare: import("node:sqlite").DatabaseSync["prepare"];
}

export interface ControlMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: ControlMigrationDatabase) => void;
}

export const CONTROL_MIGRATIONS: readonly ControlMigration[] = [
  {
    version: 1,
    name: "baseline",
    up: (db) => {
      db.exec(CONTROL_BASELINE_SCHEMA_SQL);
      db.exec(`
        INSERT OR IGNORE INTO roles(name, description) VALUES
          ('owner', '租户所有者'),
          ('admin', '租户管理员'),
          ('member', '租户成员');
      `);
    },
  },
  {
    version: 2,
    name: "widget-control-plane",
    up: (db) => {
      db.exec(CONTROL_WIDGET_SCHEMA_SQL);
    },
  },
];

export function runControlMigrations(db: ControlMigrationDatabase): void {
  const ordered = [...CONTROL_MIGRATIONS].sort((left, right) => left.version - right.version);
  assertVersionsContiguous(ordered);
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const currentVersion = Number(row?.user_version ?? 0);
  for (const migration of ordered) {
    if (migration.version <= currentVersion) continue;
    runInTransaction(db, () => {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
    });
  }
}

export const CONTROL_LATEST_SCHEMA_VERSION = CONTROL_MIGRATIONS.reduce(
  (latest, migration) => Math.max(latest, migration.version),
  0,
);
