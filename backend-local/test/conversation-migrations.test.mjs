import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runMigrations } from "../dist/adapters/local/sqlite/conversation-store/migrations.js";
import { BASELINE_SCHEMA_SQL } from "../dist/adapters/local/sqlite/conversation-store/schema.js";

const withoutContentParts = sql => sql.replace("      content_parts TEXT NOT NULL DEFAULT '[]',\n", "");
const withoutRunIdentity = sql => sql
  .replace("      agent_call_id TEXT NOT NULL,\n", "")
  .replace("      lineage_parent_call_id TEXT,\n", "")
  .replace("      agent_display_name TEXT NOT NULL,\n", "")
  .replace("      lease_root_run_id TEXT NOT NULL,\n", "")
  .replace("    CREATE UNIQUE INDEX IF NOT EXISTS runs_session_agent_call_idx\n      ON runs(session_id, agent_call_id);\n", "")
  .replace("    CREATE INDEX IF NOT EXISTS runs_lease_root_status_idx\n      ON runs(session_id, lease_root_run_id, status);\n", "");
const nullableRunIdentity = sql => sql
  .replace("      agent_call_id TEXT NOT NULL,\n", "      agent_call_id TEXT,\n")
  .replace("      agent_display_name TEXT NOT NULL,\n", "      agent_display_name TEXT,\n")
  .replace("      lease_root_run_id TEXT NOT NULL,\n", "      lease_root_run_id TEXT,\n");

test("conversation schema v1 upgrades to v9 without replacing run data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutContentParts(withoutRunIdentity(BASELINE_SCHEMA_SQL)
      .replace("      terminal_reason TEXT,\n", "")
      .replace("      removed_at TIMESTAMP,\n", "")));
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
    assert.equal(version.user_version, 9);
    assert.equal(columns.some((column) => column.name === "terminal_reason"), true);
    assert.equal(columns.find((column) => column.name === "agent_call_id")?.notnull, 1);
    assert.equal(columns.find((column) => column.name === "agent_display_name")?.notnull, 1);
    assert.equal(columns.find((column) => column.name === "lease_root_run_id")?.notnull, 1);
    assert.equal(workspaceColumns.some((column) => column.name === "removed_at"), true);
    assert.equal(run.task_summary, "preserved task");
    assert.equal(run.terminal_reason, null);
  } finally {
    db.close();
  }
});

test("conversation schema v2 upgrades to v9 without replacing sessions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutContentParts(withoutRunIdentity(BASELINE_SCHEMA_SQL).replace("      removed_at TIMESTAMP,\n", "")));
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
    assert.equal(version.user_version, 9);
    assert.equal(session.workspace_id, "workspace-1");
  } finally {
    db.close();
  }
});

test("conversation schema v3 upgrades to v9 and purges only removed workspaces without sessions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutContentParts(withoutRunIdentity(BASELINE_SCHEMA_SQL)));
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
    assert.equal(version.user_version, 9);
    assert.equal(emptyWorkspace, undefined);
    assert.notEqual(usedWorkspace.removed_at, null);
  } finally {
    db.close();
  }
});

test("conversation schema v4 upgrades to v9 and migrates structured content_parts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutContentParts(withoutRunIdentity(BASELINE_SCHEMA_SQL)));
    db.exec("PRAGMA user_version = 4");
    db.prepare(`
      INSERT INTO sessions (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel
      ) VALUES (?, ?, ?, 'private', 'direct', 'web')
    `).run("session-1", "tnt_test", "usr_test");
    const insert = db.prepare("INSERT INTO messages(id,session_id,role,content,metadata) VALUES(?,?,?,?,?)");
    insert.run("assistant-1", "session-1", "assistant", "text fallback", JSON.stringify({
      extensions: [{
        kind: "rich_content",
        version: 1,
        data: { parts: [
          { type: "text", text: "Map: " },
          { type: "file_ref", file_path: "results/map.png", presentation: "inline" },
        ] },
      }],
    }));
    insert.run("user-1", "session-1", "user", "input", JSON.stringify({
      extensions: [{
        kind: "attachments",
        version: 1,
        data: { items: [{
          file_id: "file-1",
          original_name: "input.nc",
          stored_name: "file-1_input.nc",
          mime: "application/x-netcdf",
          size: 12,
          kind: "file",
          file_path: "D:/data/input.nc",
          file_path_space: "absolute",
        }] },
      }],
    }));

    runMigrations(db);

    const rows = db.prepare("SELECT id,content_parts,metadata FROM messages ORDER BY seq").all();
    assert.deepEqual(JSON.parse(rows[0].content_parts), [
      { type: "text", text: "Map: " },
      { type: "file_ref", file_path: "results/map.png", presentation: "inline" },
    ]);
    assert.deepEqual(JSON.parse(rows[1].content_parts), [
      { type: "text", text: "input" },
      {
        type: "attachment_ref",
        file_id: "file-1",
        original_name: "input.nc",
        stored_name: "file-1_input.nc",
        mime: "application/x-netcdf",
        size: 12,
        kind: "file",
        presentation: "attachment",
        file_path: "D:/data/input.nc",
        file_path_space: "absolute",
      },
    ]);
    assert.equal(Object.hasOwn(JSON.parse(rows[0].metadata), "extensions"), false);
    assert.equal(Object.hasOwn(JSON.parse(rows[1].metadata), "extensions"), false);
  } finally {
    db.close();
  }
});

test("conversation schema v5 upgrades to v9 and migrates slash commands", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutRunIdentity(BASELINE_SCHEMA_SQL));
    db.exec("PRAGMA user_version = 5");
    db.prepare(`
      INSERT INTO sessions (session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel)
      VALUES (?, ?, ?, 'private', 'direct', 'web')
    `).run("session-1", "tnt_test", "usr_test");
    const insert = db.prepare(`
      INSERT INTO messages(id,session_id,role,content,content_parts,metadata)
      VALUES(?,?,?,?,?,?)
    `);
    insert.run("command-1", "session-1", "user", "/review src", JSON.stringify([
      { type: "text", text: "/review src" },
    ]), JSON.stringify({
      msg_type: "command",
      command: "review",
      command_mode: "prompt",
      expanded_task: "请审查 src",
    }));
    insert.run("result-1", "session-1", "system", "已执行", JSON.stringify([
      { type: "text", text: "已执行" },
    ]), JSON.stringify({
      msg_type: "command_result",
      command: "review",
      success: true,
    }));

    runMigrations(db);

    const rows = db.prepare("SELECT content_parts,metadata FROM messages ORDER BY seq").all();
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 9);
    assert.deepEqual(JSON.parse(rows[0].content_parts), [{
      type: "command_ref",
      invocation_id: "cmd_command-1",
      name: "review",
      args: "src",
      raw_text: "/review src",
      resolution: { kind: "prompt", agent_text: "请审查 src", snapshot_id: "migration:command-1" },
    }]);
    assert.deepEqual(JSON.parse(rows[1].content_parts), [{
      type: "command_result",
      invocation_id: "cmd_command-1",
      name: "review",
      success: true,
      text: "已执行",
    }]);
    assert.deepEqual(JSON.parse(rows[0].metadata), {});
    assert.deepEqual(JSON.parse(rows[1].metadata), {});
  } finally {
    db.close();
  }
});

test("conversation schema v7 upgrades to v9 and repairs nullable run lifecycle identity columns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(nullableRunIdentity(BASELINE_SCHEMA_SQL));
    db.exec("PRAGMA user_version = 7");
    db.prepare(`
      INSERT INTO sessions (session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel)
      VALUES (?, ?, ?, 'private', 'direct', 'web')
    `).run("session-1", "tnt_test", "usr_test");
    db.prepare(`
      INSERT INTO runs (run_id, session_id, tenant_id, status, agent_call_id, agent_display_name, lease_root_run_id)
      VALUES (?, ?, ?, 'failed', NULL, NULL, NULL)
    `).run("run-1", "session-1", "tnt_test");

    runMigrations(db);

    const version = db.prepare("PRAGMA user_version").get();
    const columns = db.prepare("PRAGMA table_info(runs)").all();
    const run = db.prepare("SELECT agent_call_id, agent_display_name, lease_root_run_id FROM runs WHERE run_id=?").get("run-1");
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'").all();
    assert.equal(version.user_version, 9);
    assert.equal(columns.find((column) => column.name === "agent_call_id")?.notnull, 1);
    assert.equal(columns.find((column) => column.name === "agent_display_name")?.notnull, 1);
    assert.equal(columns.find((column) => column.name === "lease_root_run_id")?.notnull, 1);
    assert.equal(run.agent_call_id, "run-1");
    assert.equal(run.agent_display_name, "unknown");
    assert.equal(run.lease_root_run_id, "run-1");
    assert.equal(indexes.some((index) => index.name === "runs_session_agent_call_idx"), true);
    assert.equal(indexes.some((index) => index.name === "runs_lease_root_status_idx"), true);
  } finally {
    db.close();
  }
});
