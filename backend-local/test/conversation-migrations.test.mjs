import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runMigrations } from "../dist/adapters/local/sqlite/conversation-store/migrations.js";
import { BASELINE_SCHEMA_SQL } from "../dist/adapters/local/sqlite/conversation-store/schema.js";

test("conversation schema v1 upgrades to v2 without replacing run data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BASELINE_SCHEMA_SQL.replace("      terminal_reason TEXT,\n", ""));
    db.exec("PRAGMA user_version = 1");
    db.prepare(`
      INSERT INTO sessions (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel
      ) VALUES (?, ?, ?, 'private', 'direct', 'web')
    `).run("session-1", "tnt_test", "usr_test");
    db.prepare(`
      INSERT INTO runs (run_id, session_id, tenant_id, status, task_summary)
      VALUES (?, ?, ?, 'failed', ?)
    `).run("run-1", "session-1", "tnt_test", "preserved task");

    runMigrations(db);

    const version = db.prepare("PRAGMA user_version").get();
    const columns = db.prepare("PRAGMA table_info(runs)").all();
    const run = db.prepare("SELECT task_summary, terminal_reason FROM runs WHERE run_id=?").get("run-1");
    assert.equal(version.user_version, 2);
    assert.equal(columns.some((column) => column.name === "terminal_reason"), true);
    assert.equal(run.task_summary, "preserved task");
    assert.equal(run.terminal_reason, null);
  } finally {
    db.close();
  }
});
