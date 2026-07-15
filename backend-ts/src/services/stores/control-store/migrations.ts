import { assertVersionsContiguous } from "../conversation-store/migrations.js";
import { runInTransaction } from "../conversation-store/shared/transaction.js";
import { CONTROL_AUTH_SCHEMA_SQL, CONTROL_BASELINE_SCHEMA_SQL, CONTROL_BOT_CONFIG_SCHEMA_SQL, CONTROL_BOT_SCHEMA_SQL, CONTROL_WIDGET_SCHEMA_SQL } from "./schema.js";

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
  {
    version: 3,
    name: "password-auth-control-plane",
    up: (db) => {
      db.exec(CONTROL_AUTH_SCHEMA_SQL);
    },
  },
  {
    version: 4,
    name: "platform-control-plane",
    up: (db) => {
      db.exec(`
        ALTER TABLE users ADD COLUMN platform_role TEXT;
        ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
        ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

        CREATE INDEX idx_users_status ON users(status);
        CREATE INDEX idx_tenants_status ON tenants(status);
        CREATE INDEX idx_users_platform_role ON users(platform_role);

        CREATE TABLE platform_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_user_id TEXT NOT NULL,
          action TEXT NOT NULL,
          target_tenant_id TEXT,
          target_resource TEXT NOT NULL,
          detail_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
          FOREIGN KEY (target_tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
        );
        CREATE INDEX idx_platform_audit_created_at ON platform_audit(created_at DESC, id DESC);
      `);
    },
  },
  {
    version: 5,
    name: "bot-users",
    up: (db) => {
      db.exec(CONTROL_BOT_SCHEMA_SQL);
    },
  },
  {
    version: 6,
    name: "bot-configs-and-cron",
    up: (db) => {
      db.exec(CONTROL_BOT_CONFIG_SCHEMA_SQL);
    },
  },
  {
    version: 7,
    name: "bot-permission-mode",
    up: (db) => {
      db.exec("ALTER TABLE bot_configs ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'relaxed'");
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
