import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SQLITE_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

const agents = { assistant: { agent_name: "assistant" } };

function seedSession(store, sessionId = "session-1") {
  store.createSession({
    sessionId,
    tenantId: "tnt_test",
    ownerUserId: "usr_test",
    visibility: "private",
    originType: "direct",
    originId: null,
    originChannel: "web",
    workspaceId: null,
    permissionMode: null,
    teamSnapshot: {
      team_name: "default",
      team_revision: computeSessionTeamRevision(agents),
      entry_agent_name: "assistant",
      agents,
    },
    metadata: {},
  });
}

function seedRun(store, sessionId = "session-1", runId = "run-1", status = "completed") {
  store.createRun({
    runId,
    sessionId,
    status,
    taskSummary: "test run",
    agentCallId: `call:${runId}`,
    lineageParentCallId: null,
    agentDisplayName: "assistant",
    leaseRootRunId: runId,
  });
}

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-ts-"));
  return { dbPath: path.join(dir, "conv.db"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("store exits return timezone-marked ISO timestamps for live writes", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    seedSession(store);
    const session = store.getSession("session-1");
    assert.match(session.created_at, ISO_Z);
    assert.match(session.updated_at, ISO_Z);

    const added = store.addMessage({
      sessionId: "session-1",
      role: "user",
      contentParts: [{ type: "text", text: "hello" }],
      metadata: {},
      threadKey: "root",
    });
    assert.match(added.created_at, ISO_Z, "addMessage return value must be ISO-Z");
    assert.match(store.listMessages("session-1").items[0].created_at, ISO_Z);

    seedRun(store);
    const run = store.getRun("session-1", "run-1");
    assert.match(run.created_at, ISO_Z);
    assert.match(run.updated_at, ISO_Z);
    assert.match(store.listRuns("session-1").items[0].created_at, ISO_Z);

    store.createChildAgent({ childAgentId: "child-1", sessionId: "session-1", agentName: "helper" });
    const child = store.getChildAgent("session-1", "child-1");
    assert.match(child.created_at, ISO_Z);
    assert.match(child.updated_at, ISO_Z);

    store.createPendingInteraction({
      interactionId: "itx-1",
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "run-1",
      toolCallId: "call:run-1",
      batchId: "batch-1",
      kind: "approval",
      requestPayload: { task: "ok?" },
    });
    const interaction = store.getPendingInteraction("session-1", "itx-1");
    assert.match(interaction.created_at, ISO_Z);
    assert.equal(interaction.responded_at, null);
    store.updatePendingInteractionStatus({ sessionId: "session-1", interactionId: "itx-1", status: "resolved" });
    assert.match(store.getPendingInteraction("session-1", "itx-1").responded_at, ISO_Z);

    const overview = store.getPersistedExecutionOverview(false);
    assert.match(overview.items[0].started_at, ISO_Z);
    assert.match(overview.items[0].finished_at, ISO_Z);
  } finally {
    store.close();
  }
});

test("legacy CURRENT_TIMESTAMP text converges to ISO-Z without local-time shift", () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const store = createConversationStore({ dbPath, dataRoot: process.cwd() });
    seedSession(store);
    store.addMessage({
      sessionId: "session-1",
      role: "user",
      contentParts: [{ type: "text", text: "hello" }],
      metadata: {},
      threadKey: "root",
    });
    seedRun(store);
    store.createChildAgent({ childAgentId: "child-1", sessionId: "session-1", agentName: "helper" });
    store.createPendingInteraction({
      interactionId: "itx-1",
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "run-1",
      toolCallId: "call:run-1",
      batchId: "batch-1",
      kind: "approval",
      requestPayload: { task: "ok?" },
    });
    store.close();

    // 历史形状：无 Z 的 SQLite UTC 文本（CURRENT_TIMESTAMP 产物）。
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      UPDATE sessions SET created_at='2024-01-02 03:04:05', updated_at='2024-01-02 03:04:06';
      UPDATE messages SET created_at='2024-01-02 03:04:07';
      UPDATE runs SET created_at='2024-01-02 03:04:08', updated_at='2024-01-02 03:04:09';
      UPDATE child_agents SET created_at='2024-01-02 03:04:10', updated_at='2024-01-02 03:04:11';
      UPDATE pending_interactions SET created_at='2024-01-02 03:04:12', updated_at='2024-01-02 03:04:13', responded_at='2024-01-02 03:04:14';
    `);
    raw.close();

    const reopened = createConversationStore({ dbPath, dataRoot: process.cwd() });
    try {
      const session = reopened.getSession("session-1");
      assert.equal(session.created_at, "2024-01-02T03:04:05.000Z");
      assert.equal(session.updated_at, "2024-01-02T03:04:06.000Z");
      assert.equal(reopened.listMessages("session-1").items[0].created_at, "2024-01-02T03:04:07.000Z");
      const run = reopened.getRun("session-1", "run-1");
      assert.equal(run.created_at, "2024-01-02T03:04:08.000Z");
      assert.equal(run.updated_at, "2024-01-02T03:04:09.000Z");
      const child = reopened.getChildAgent("session-1", "child-1");
      assert.equal(child.created_at, "2024-01-02T03:04:10.000Z");
      assert.equal(child.updated_at, "2024-01-02T03:04:11.000Z");
      const interaction = reopened.getPendingInteraction("session-1", "itx-1");
      assert.equal(interaction.created_at, "2024-01-02T03:04:12.000Z");
      assert.equal(interaction.responded_at, "2024-01-02T03:04:14.000Z");
      assert.equal(
        reopened.getPersistedExecutionOverview(false).items[0].started_at,
        "2024-01-02T03:04:08.000Z",
      );
      // 时刻语义必须是 UTC 03:04:05，而不是被当作本地时区平移。
      assert.equal(new Date(session.created_at).getTime(), Date.UTC(2024, 0, 2, 3, 4, 5));
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("session list projection stays in internal SQLite text format across both write paths", () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const store = createConversationStore({ dbPath, dataRoot: process.cwd() });
    seedSession(store, "session-a");
    seedSession(store, "session-b");
    store.addMessage({
      sessionId: "session-a",
      role: "user",
      contentParts: [{ type: "text", text: "first" }],
      metadata: {},
      threadKey: "root",
    });
    store.addMessage({
      sessionId: "session-b",
      role: "user",
      contentParts: [{ type: "text", text: "second" }],
      metadata: {},
      threadKey: "root",
    });

    const page = store.listSessions({ tenantId: "tnt_test", access: { includeTenant: false, includeAll: true }, limit: 1 });
    assert.equal(page.items.length, 1);
    assert.match(page.items[0].activity_at, ISO_Z);
    const next = store.listSessions({
      tenantId: "tnt_test",
      access: { includeTenant: false, includeAll: true },
      limit: 1,
      cursor: page.nextCursor,
    });
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].session_id, page.items[0].session_id);
    store.close();

    // 增量投影路径（addMessage → projectInsertedMessage）写入的 activity_at 必须保持内部格式。
    const raw = new DatabaseSync(dbPath);
    const rows = raw.prepare("SELECT session_id, activity_at FROM session_list_projection").all();
    raw.close();
    assert.equal(rows.length, 2);
    for (const row of rows) assert.match(row.activity_at, SQLITE_TEXT, `projection row ${row.session_id} must keep SQLite text format`);

    // 重建路径对手工编辑过的 ISO-Z 消息时间戳同样收敛回内部格式。
    const rawAgain = new DatabaseSync(dbPath);
    rawAgain.exec("UPDATE messages SET created_at='2024-01-02T03:04:05.000Z' WHERE session_id='session-a'");
    rawAgain.close();
    const reopened = createConversationStore({ dbPath, dataRoot: process.cwd() });
    try {
      reopened.rebuildSessionListProjection("session-a");
      const check = new DatabaseSync(dbPath);
      const row = check.prepare("SELECT activity_at FROM session_list_projection WHERE session_id='session-a'").get();
      check.close();
      assert.match(row.activity_at, SQLITE_TEXT);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});
