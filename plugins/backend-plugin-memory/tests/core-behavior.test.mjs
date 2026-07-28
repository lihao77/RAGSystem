import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/storage/local/memory-store.js";
import { POSTGRES_MEMORY_MIGRATIONS } from "../dist/storage/postgres/schema.js";

test("local Memory store rejects traversal in every scope identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-paths-"));
  try {
    const store = new MemoryStore({ dataRoot: root });
    assert.throws(() => store.getScopeRoot({ scope: "team", team_name: "../../../other" }), /非法路径字符/);
    assert.throws(() => store.getScopeRoot({ scope: "agent", team_name: "default", agent_name: "../admin" }), /非法路径字符/);
    assert.throws(() => store.getScopeRoot({ scope: "session", session_id: "..\\outside" }), /非法路径字符/);
    assert.throws(() => store.getScopeRoot({ scope: "workspace", user_id: "alice", workspace_key: "../outside" }), /非法路径字符/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local Memory store writes, indexes, and archives entries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-entry-"));
  try {
    const store = new MemoryStore({ dataRoot: root });
    const scope = { scope: "session", session_id: "session-1" };
    const saved = await store.saveMemory({
      ...scope,
      name: "Preferred format",
      description: "Use concise Markdown",
      memory_type: "preference",
      content: "Prefer concise Markdown answers.",
    });

    assert.match(store.loadIndexHead(scope), /Preferred format/);
    assert.match(fs.readFileSync(saved.file_path, "utf8"), /status: active/);
    assert.equal(await store.archiveMemory(scope, saved.file_name), true);
    assert.doesNotMatch(store.loadIndexHead(scope), /Preferred format/);
    assert.match(fs.readFileSync(saved.file_path, "utf8"), /status: archived/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local Memory store restores files when publish commit loses its race", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-rollback-"));
  try {
    const store = new MemoryStore({ dataRoot: root });
    const scope = { scope: "team", team_name: "default" };
    const before = store.loadIndexHead(scope);

    await assert.rejects(
      store.saveMemoryWithCommit({
        ...scope,
        name: "Candidate",
        description: "candidate",
        memory_type: "fact",
        content: "new",
      }, () => false),
      /memory publish state changed before commit/,
    );
    assert.equal(store.loadIndexHead(scope), before);
    assert.equal(fs.existsSync(path.join(root, "memory", "teams", "default", "fact_Candidate.md")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Memory migrations own entries, candidates, revisions, and Agent config", () => {
  const sql = POSTGRES_MEMORY_MIGRATIONS.map((migration) => migration.sql).join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS memory_entries/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS memory_candidates/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS memory_scope_revisions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS memory_agent_configs/);
});
