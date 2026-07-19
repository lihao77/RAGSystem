import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { widgetUserId } from "../../src/identity/widget-user-id.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../src/services/identity/index.js";
import { MIGRATIONS, runMigrations } from "../../src/adapters/local/sqlite/conversation-store/migrations.js";

const requireModule = createRequire(import.meta.url);
const sqlite = requireModule("node:sqlite") as typeof import("node:sqlite");

describe("migration v8 private_session_owners", () => {
  it("normalizes widget owners, syncs runs, and only backfills local null owners", () => {
    const db = new sqlite.DatabaseSync(":memory:");
    migrateThroughV7(db);
    db.prepare("INSERT INTO sessions(session_id, tenant_id, user_id) VALUES (?, ?, ?)")
      .run("widget-session", "tnt_widget", "widget:App.Key-1");
    db.prepare("INSERT INTO sessions(session_id, tenant_id, user_id) VALUES (?, ?, NULL)")
      .run("local-session", LOCAL_TENANT_ID);
    db.prepare("INSERT INTO sessions(session_id, tenant_id, user_id) VALUES (?, ?, NULL)")
      .run("saas-orphan", "tnt_saas");
    db.prepare("INSERT INTO runs(run_id, session_id, tenant_id, user_id) VALUES (?, ?, ?, ?)")
      .run("widget-run", "widget-session", "tnt_widget", "widget:App.Key-1");
    db.prepare("INSERT INTO runs(run_id, session_id, tenant_id, user_id) VALUES (?, ?, ?, NULL)")
      .run("local-run", "local-session", LOCAL_TENANT_ID);

    runMigrations(db);

    expect(db.prepare("SELECT user_id FROM sessions WHERE session_id='widget-session'").get())
      .toEqual({ user_id: widgetUserId("App.Key-1") });
    expect(db.prepare("SELECT user_id FROM runs WHERE run_id='widget-run'").get())
      .toEqual({ user_id: widgetUserId("App.Key-1") });
    expect(db.prepare("SELECT user_id FROM sessions WHERE session_id='local-session'").get())
      .toEqual({ user_id: LOCAL_USER_ID });
    expect(db.prepare("SELECT user_id FROM runs WHERE run_id='local-run'").get())
      .toEqual({ user_id: LOCAL_USER_ID });
    expect(db.prepare("SELECT user_id FROM sessions WHERE session_id='saas-orphan'").get())
      .toEqual({ user_id: null });
    db.close();
  });

  it("aborts with a report for an unparseable historical widget owner", () => {
    const db = new sqlite.DatabaseSync(":memory:");
    migrateThroughV7(db);
    db.prepare("INSERT INTO sessions(session_id, tenant_id, user_id) VALUES (?, ?, ?)")
      .run("bad-widget", "tnt_widget", "widget:");

    expect(() => runMigrations(db)).toThrow("bad-widget=widget:");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    db.close();
  });
});

function migrateThroughV7(db: InstanceType<typeof sqlite.DatabaseSync>): void {
  for (const migration of MIGRATIONS.filter((item) => item.version <= 7)) {
    migration.up(db);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
}
