import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runMigrations } from "../dist/adapters/local/sqlite/conversation-store/migrations.js";
import { BASELINE_SCHEMA_SQL } from "../dist/adapters/local/sqlite/conversation-store/schema.js";

test("conversation schema v1 upgrades to v4 without replacing run data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BASELINE_SCHEMA_SQL
      .replace("      terminal_reason TEXT,\n", "")
      .replace("      removed_at TIMESTAMP,\n", ""));
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
    const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all();
    assert.equal(version.user_version, 4);
    assert.equal(columns.some((column) => column.name === "terminal_reason"), true);
    assert.equal(workspaceColumns.some((column) => column.name === "removed_at"), true);
    assert.equal(run.task_summary, "preserved task");
    assert.equal(run.terminal_reason, null);
  } finally {
    db.close();
  }
});

test("conversation schema v2 upgrades to v4 without replacing sessions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BASELINE_SCHEMA_SQL.replace("      removed_at TIMESTAMP,\n", ""));
    db.exec("PRAGMA user_version = 2");
    db.prepare(`
      INSERT INTO workspaces (workspace_id, tenant_id, kind, display_name, root_path, canonical_key)
      VALUES (?, ?, 'local', ?, ?, ?)
    `).run("workspace-1", "tnt_test", "ragsystem", "D:/work", "d:/work");
    db.prepare(`
      INSERT INTO sessions (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel, workspace_id
      ) VALUES (?, ?, ?, 'private', 'direct', 'web', ?)
    `).run("session-1", "tnt_test", "usr_test", "workspace-1");

    runMigrations(db);

    const version = db.prepare("PRAGMA user_version").get();
    const session = db.prepare("SELECT workspace_id FROM sessions WHERE session_id=?").get("session-1");
    assert.equal(version.user_version, 4);
    assert.equal(session.workspace_id, "workspace-1");
  } finally {
    db.close();
  }
});

test("conversation schema v3 purges only removed workspaces without sessions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BASELINE_SCHEMA_SQL);
    db.exec("PRAGMA user_version = 3");
    const insertWorkspace = db.prepare(`
      INSERT INTO workspaces (
        workspace_id, tenant_id, kind, display_name, root_path, canonical_key, removed_at
      ) VALUES (?, ?, 'local', ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    insertWorkspace.run("workspace-empty", "tnt_test", "empty", "D:/empty", "d:/empty");
    insertWorkspace.run("workspace-used", "tnt_test", "used", "D:/used", "d:/used");
    db.prepare(`
      INSERT INTO sessions (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel, workspace_id
      ) VALUES (?, ?, ?, 'private', 'direct', 'web', ?)
    `).run("session-1", "tnt_test", "usr_test", "workspace-used");

    runMigrations(db);

    const version = db.prepare("PRAGMA user_version").get();
    const emptyWorkspace = db.prepare("SELECT workspace_id FROM workspaces WHERE workspace_id=?").get("workspace-empty");
    const usedWorkspace = db.prepare("SELECT removed_at FROM workspaces WHERE workspace_id=?").get("workspace-used");
    assert.equal(version.user_version, 4);
    assert.equal(emptyWorkspace, undefined);
    assert.notEqual(usedWorkspace.removed_at, null);
  } finally {
    db.close();
  }
});
