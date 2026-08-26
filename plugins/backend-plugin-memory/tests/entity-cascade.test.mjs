import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { MemoryStore } from "../dist/storage/local/memory-store.js";
import { createLocalMemoryRuntimeFactory } from "../dist/storage/local/runtime.js";
import { MemoryCandidateOps } from "../dist/storage/local/candidate-store.js";
import { startSessionMemoryReconciliation } from "../dist/services/memory/session-reconcile.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

async function createRuntime(root, sessionsById) {
  const factory = createLocalMemoryRuntimeFactory();
  return factory({
    deploymentKind: "local",
    tenantId: "tnt_test",
    dataRoot: root,
    sessions: {
      getSession: async (sessionId) => sessionsById.get(sessionId) ?? null,
      listWorkspacesByIds: async () => [],
    },
    systemConfig: { getSection: () => ({}) },
  });
}

function openCandidateStore(root) {
  const db = new DatabaseSync(path.join(root, "db", "memory.db"));
  return {
    ops: new MemoryCandidateOps(db),
    close: () => db.close(),
  };
}

test("purge removes session memory scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-purge-session-"));
  try {
    const store = new MemoryStore({ dataRoot: root });
    await store.saveMemory({
      scope: "session", session_id: "ses_1",
      name: "Format", description: "Prefers Markdown", memory_type: "preference",
      content: "Prefer Markdown.",
    });
    assert.ok(store.listSessionScopeIds().includes("ses_1"));

    const runtime = await createRuntime(root, new Map([["ses_1", { session_id: "ses_1" }]]));
    assert.equal(await runtime.purge({ scope: "session", sessionId: "ses_1" }), true);
    assert.ok(!store.listSessionScopeIds().includes("ses_1"));
    assert.equal(await runtime.purge({ scope: "session", sessionId: "ses_1" }), false);
    runtime.dispose?.();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("purge removes agent memory, config, and pending candidates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-purge-agent-"));
  try {
    const store = new MemoryStore({ dataRoot: root });
    await store.saveMemory({
      scope: "agent", team_name: "research", agent_name: "writer",
      name: "Style", description: "Concise tone", memory_type: "preference",
      content: "Keep answers concise.",
    });
    const runtime = await createRuntime(root, new Map());
    await runtime.agentConfig.put({ teamName: "research", agentName: "writer" }, { enabled: false });
    const candidateStore = openCandidateStore(root);
    const candidates = candidateStore.ops;
    candidates.createMemoryCandidate({
      tenantId: "tnt_test", ownerUserId: "usr_1", targetScope: "agent",
      teamName: "research", agentName: "writer",
      name: "Draft", description: "pending", memoryType: "fact", content: "pending fact",
    });
    assert.equal(candidates.listMemoryCandidates({ teamName: "research", agentName: "writer" }).length, 1);

    assert.equal(await runtime.purge({ scope: "agent", teamName: "research", agentName: "writer" }), true);
    assert.equal(fs.existsSync(path.join(root, "memory", "teams", "research", "agents", "writer")), false);
    assert.equal(await runtime.agentConfig.getEffective({ teamName: "research", agentName: "writer" }).then((config) => config.enabled), true);
    assert.equal(candidates.listMemoryCandidates({ teamName: "research", agentName: "writer" }).length, 0);
    runtime.dispose?.();
    candidateStore.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("purge removes the whole team subtree including its agents", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-purge-team-"));
  try {
    const store = new MemoryStore({ dataRoot: root });
    await store.saveMemory({
      scope: "team", team_name: "research",
      name: "Charter", description: "Team charter", memory_type: "goal",
      content: "Ship weekly.",
    });
    await store.saveMemory({
      scope: "agent", team_name: "research", agent_name: "writer",
      name: "Style", description: "Concise tone", memory_type: "preference",
      content: "Keep answers concise.",
    });
    const runtime = await createRuntime(root, new Map());
    await runtime.agentConfig.put({ teamName: "research", agentName: "writer" }, { enabled: true });

    assert.equal(await runtime.purge({ scope: "team", teamName: "research" }), true);
    assert.equal(fs.existsSync(path.join(root, "memory", "teams", "research")), false);
    runtime.dispose?.();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrateTeam moves memory directories, configs, and candidates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-migrate-team-"));
  try {
    const store = new MemoryStore({ dataRoot: root });
    await store.saveMemory({
      scope: "team", team_name: "alpha",
      name: "Charter", description: "Team charter", memory_type: "goal",
      content: "Ship weekly.",
    });
    await store.saveMemory({
      scope: "agent", team_name: "alpha", agent_name: "writer",
      name: "Style", description: "Concise tone", memory_type: "preference",
      content: "Keep answers concise.",
    });
    const runtime = await createRuntime(root, new Map());
    await runtime.agentConfig.put({ teamName: "alpha", agentName: "writer" }, { enabled: false });
    const candidateStore = openCandidateStore(root);
    const candidates = candidateStore.ops;
    candidates.createMemoryCandidate({
      tenantId: "tnt_test", ownerUserId: "usr_1", targetScope: "team",
      teamName: "alpha",
      name: "Draft", description: "pending", memoryType: "fact", content: "pending fact",
    });

    await runtime.migrateTeam("alpha", "beta");
    assert.equal(fs.existsSync(path.join(root, "memory", "teams", "alpha")), false);
    assert.equal(fs.existsSync(path.join(root, "memory", "teams", "beta", "agents", "writer")), true);
    assert.equal(await runtime.agentConfig.getEffective({ teamName: "beta", agentName: "writer" }).then((config) => config.enabled), false);
    assert.equal(candidates.listMemoryCandidates({ teamName: "beta" }).length, 1);
    runtime.dispose?.();
    candidateStore.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session reconciliation purges only orphaned session scopes", async () => {
  const sessions = new Map([
    ["ses_live", { session_id: "ses_live" }],
  ]);
  const stored = new Set(["ses_live", "ses_orphan"]);
  const purged = [];
  const reconciliation = startSessionMemoryReconciliation({
    listSessionScopeIds: () => [...stored],
    getSession: async (sessionId) => sessions.get(sessionId) ?? null,
    purgeSession: async (sessionId) => {
      purged.push(sessionId);
      stored.delete(sessionId);
      return true;
    },
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(purged, ["ses_orphan"]);
    assert.deepEqual([...stored], ["ses_live"]);
  } finally {
    reconciliation.stop();
  }
});
