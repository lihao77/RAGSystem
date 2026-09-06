import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { SqliteRuntimeStorage } from "../dist/adapters/local/sqlite-runtime-storage.js";
import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";

const agents = { orchestrator_agent: { agent_name: "orchestrator_agent" } };
const teamSnapshot = { team_name: "test", team_revision: computeSessionTeamRevision(agents), entry_agent_name: "orchestrator_agent", agents };

function createSession(store) {
  store.createSession({
    tenantId: "tnt_test",
    sessionId: "session-mailbox",
    ownerUserId: "usr_test",
    visibility: "private",
    originType: "direct",
    originId: null,
    originChannel: "web",
    workspaceId: null,
    teamSnapshot,
    metadata: {},
    permissionMode: null,
  });
}

function createStore() {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  createSession(store);
  return store;
}

test("local Agent mailbox round-trips input envelope fields and applies defaults", async () => {
  const store = createStore();
  try {
    const explicit = await store.agentMailbox.enqueue({
      messageId: "message-envelope",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetThreadKey: "root",
      kind: "request",
      inputType: "user_message",
      sourceKind: "user",
      visibleToUser: true,
      sentAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(explicit.input_type, "user_message");
    assert.equal(explicit.source_kind, "user");
    assert.equal(explicit.visible_to_user, true);
    assert.equal(explicit.sent_at, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(await store.agentMailbox.get("session-mailbox", "message-envelope"), explicit);
    await assert.rejects(() => store.agentMailbox.enqueue({
      messageId: "message-envelope",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetThreadKey: "root",
      kind: "request",
      inputType: "agent_message",
      sourceKind: "user",
      visibleToUser: true,
      sentAt: "2026-01-01T00:00:00.000Z",
    }), /another message/);

    const defaults = await store.agentMailbox.enqueue({
      messageId: "message-envelope-defaults",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetThreadKey: "root",
      kind: "progress",
    });
    assert.equal(defaults.input_type, "agent_message");
    assert.equal(defaults.source_kind, "agent");
    assert.equal(defaults.visible_to_user, false);
    assert.equal(defaults.sent_at, null);
  } finally {
    store.close();
  }
});

test("local Agent mailbox is durable, FIFO, and fenced by claim id", async () => {
  const store = createStore();
  try {
    const mailbox = store.agentMailbox;
    await mailbox.enqueue({ messageId: "message-1", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "child-thread", targetChildAgentId: "child-1", kind: "request", contentParts: [{ type: "text", text: "first" }], availableAt: "2026-01-01T00:00:00.000Z" });
    const duplicate = await mailbox.enqueue({ messageId: "message-1", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "child-thread", targetChildAgentId: "child-1", kind: "request", contentParts: [{ type: "text", text: "first" }], availableAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(duplicate.content_parts[0].text, "first");
    await assert.rejects(() => mailbox.enqueue({ messageId: "message-1", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "child-thread", targetChildAgentId: "child-1", kind: "request", contentParts: [{ type: "text", text: "different" }], availableAt: "2026-01-01T00:00:00.000Z" }));
    await mailbox.enqueue({ messageId: "message-2", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "child-thread", targetChildAgentId: "child-1", kind: "progress", contentParts: [{ type: "text", text: "second" }], availableAt: "2026-01-01T00:00:00.000Z" });
    const pending = await mailbox.listPending({ sessionId: "session-mailbox", targetThreadKey: "child-thread", targetChildAgentId: "child-1", now: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(pending.map((message) => message.message_id), ["message-1", "message-2"]);

    const claimed = await mailbox.claim({ sessionId: "session-mailbox", targetThreadKey: "child-thread", targetChildAgentId: "child-1", claimId: "claim-1", consumerId: "worker-1", leaseMs: 1000, now: "2026-01-01T00:00:00.000Z", limit: 10 });
    assert.deepEqual(claimed.map((message) => message.message_id), ["message-1", "message-2"]);
    assert.equal(claimed[0].attempt_count, 1);
    assert.equal(await mailbox.ack({ sessionId: "session-mailbox", messageId: "message-1", claimId: "stale" }), false);
    assert.equal(await mailbox.release({ sessionId: "session-mailbox", messageId: "message-1", claimId: "claim-1", availableAt: "2026-01-01T00:00:00.000Z", lastError: "retry" }), true);
    assert.equal(await mailbox.ack({ sessionId: "session-mailbox", messageId: "message-2", claimId: "claim-1" }), true);

    const reclaimed = await mailbox.claim({ sessionId: "session-mailbox", targetThreadKey: "child-thread", targetChildAgentId: "child-1", claimId: "claim-2", consumerId: "worker-2", now: "2026-01-01T00:00:02.000Z" });
    assert.deepEqual(reclaimed.map((message) => message.message_id), ["message-1"]);
    assert.equal(reclaimed[0].attempt_count, 2);
    assert.equal(await mailbox.settle({ sessionId: "session-mailbox", messageId: "message-1" }), true);
    assert.equal(await mailbox.settle({ sessionId: "session-mailbox", messageId: "message-1" }), true);
    assert.equal((await mailbox.get("session-mailbox", "message-1")).status, "acked");
    // settle 对不存在的消息是幂等空转（后台通知抑制依赖此行为：suppress 先于
    // enqueue 到达时不得留下会拦住后续入队的墓碑）。
    assert.equal(await mailbox.settle({ sessionId: "session-mailbox", messageId: "never-enqueued" }), false);

    // 认领谓词=纯分支（§10.4 第七轮）：root 分支的全部行一并认领——排队用户消息、
    // 后台通知、历史带溯源 run 字段的行（同分支即同收件人，run 段不再隔离认领）。
    await mailbox.enqueue({ messageId: "queued-user", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "root", kind: "request", inputType: "user_message", sourceKind: "user", visibleToUser: true, contentParts: [{ type: "text", text: "followup" }] });
    await mailbox.enqueue({ messageId: "bg-notify", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "root", kind: "request", inputType: "system_notification", sourceKind: "system", contentParts: [{ type: "text", text: "notify" }] });
    await mailbox.enqueue({ messageId: "targeted-agent", tenantId: "tnt_test", sessionId: "session-mailbox", targetRunId: "run-active", targetThreadKey: "root", kind: "request", inputType: "agent_message", contentParts: [{ type: "text", text: "direct" }] });
    const idleClaimed = await mailbox.claim({ sessionId: "session-mailbox", targetThreadKey: "root", claimId: "claim-idle", consumerId: "idle-scan" });
    assert.deepEqual(idleClaimed.map((message) => message.message_id), ["queued-user", "bg-notify", "targeted-agent"]);
  } finally {
    store.close();
  }
});

test("local Agent mailbox re-enqueues a legacy directed row verbatim (identity round-trip)", async () => {
  const store = createStore();
  try {
    const mailbox = store.agentMailbox;
    // §10.4 第七轮回归钉子：纯分支认领会把历史带 run 段/correlation/sent_at 为空的
    // 定向行收进主分支批次；伴随行物化（appendMailboxMessage）重建信封必须逐字段
    // 精确回传，否则同 id 重入队被判"异形状"抛错（曾致 idle 消费热循环）。
    const legacy = await mailbox.enqueue({
      messageId: "legacy-directed", tenantId: "tnt_test", sessionId: "session-mailbox",
      sourceRunId: "src-run", sourceAgentCallId: "src-call", targetAgentCallId: "run-call",
      targetThreadKey: "root", kind: "request", inputType: "agent_message",
      correlationId: "corr-legacy", replyToMessageId: "orig-1",
      contentParts: [{ type: "text", text: "direct" }],
      metadata: { source: "agent", target_run_id: "run-active" },
    });
    assert.equal(legacy.sent_at, null);
    const verbatim = await mailbox.enqueue({
      messageId: "legacy-directed", tenantId: "tnt_test", sessionId: "session-mailbox",
      sourceRunId: "src-run", sourceAgentCallId: "src-call", targetAgentCallId: "run-call",
      targetThreadKey: "root", kind: "request", inputType: "agent_message",
      correlationId: "corr-legacy", replyToMessageId: "orig-1",
      contentParts: [{ type: "text", text: "direct" }],
      metadata: { source: "agent", target_run_id: "run-active" },
    });
    assert.equal(verbatim.message_id, legacy.message_id);
    await assert.rejects(() => mailbox.enqueue({
      messageId: "legacy-directed", tenantId: "tnt_test", sessionId: "session-mailbox",
      targetThreadKey: "root", kind: "request", inputType: "agent_message",
      contentParts: [{ type: "text", text: "direct" }],
      metadata: { source: "agent", target_run_id: "run-active" },
    }), /another message/);
  } finally {
    store.close();
  }
});

test("local Agent mailbox scopes message ids by tenant", async () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    createSession(store);
    store.createSession({
      tenantId: "tnt_other",
      sessionId: "session-mailbox-other",
      ownerUserId: "usr_other",
      visibility: "private",
      originType: "direct",
      originId: null,
      originChannel: "web",
      workspaceId: null,
      teamSnapshot,
      metadata: {},
      permissionMode: null,
    });
    await store.agentMailbox.enqueue({
      messageId: "shared-message-id",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetThreadKey: "child-thread",
      kind: "request",
      contentParts: [{ type: "text", text: "tenant one" }],
    });
    const other = await store.agentMailbox.enqueue({
      messageId: "shared-message-id",
      tenantId: "tnt_other",
      sessionId: "session-mailbox-other",
      targetThreadKey: "child-thread",
      kind: "request",
      contentParts: [{ type: "text", text: "tenant two" }],
    });
    assert.equal(other.content_parts[0].text, "tenant two");
    assert.equal((await store.agentMailbox.get("session-mailbox", "shared-message-id")).content_parts[0].text, "tenant one");
  } finally {
    store.close();
  }
});

test("local Agent mailbox expires queued messages and reclaims expired leases", async () => {
  const store = createStore();
  try {
    const mailbox = store.agentMailbox;
    await mailbox.enqueue({ messageId: "message-expired", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "child-thread", kind: "request", expiresAt: "2026-01-01T00:00:01.000Z" });
    assert.equal(await mailbox.expire({ now: "2026-01-01T00:00:02.000Z" }), 1);
    assert.equal((await mailbox.get("session-mailbox", "message-expired")).status, "expired");

    await mailbox.enqueue({ messageId: "message-lease", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "child-thread", kind: "request", availableAt: "2026-01-01T00:00:00.000Z" });
    await mailbox.claim({ sessionId: "session-mailbox", targetThreadKey: "child-thread", claimId: "claim-old", consumerId: "worker-old", leaseMs: 1000, now: "2026-01-01T00:00:00.000Z" });
    const reclaimed = await mailbox.claim({ sessionId: "session-mailbox", targetThreadKey: "child-thread", claimId: "claim-new", consumerId: "worker-new", now: "2026-01-01T00:00:02.000Z" });
    assert.equal(reclaimed[0].message_id, "message-lease");
    assert.equal(await mailbox.ack({ sessionId: "session-mailbox", messageId: "message-lease", claimId: "claim-old" }), false);
    assert.equal(await mailbox.ack({ sessionId: "session-mailbox", messageId: "message-lease", claimId: "claim-new" }), true);
  } finally {
    store.close();
  }
});

test("local Agent mailbox active claims fence the thread tuple", async () => {
  const store = createStore();
  try {
    const mailbox = store.agentMailbox;
    await mailbox.enqueue({
      messageId: "active-target-message",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetThreadKey: "child-thread",
      targetChildAgentId: "child-1",
      kind: "result",
      contentParts: [{ type: "text", text: "terminal" }],
      availableAt: "2026-01-01T00:00:00.000Z",
    });
    const wrongThread = await mailbox.claim({
      sessionId: "session-mailbox",
      targetThreadKey: "other-thread",
      targetChildAgentId: "child-1",
      claimId: "claim-wrong-thread",
      consumerId: "worker-wrong-thread",
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(wrongThread, []);
    const wrongChild = await mailbox.claim({
      sessionId: "session-mailbox",
      targetThreadKey: "child-thread",
      targetChildAgentId: "child-2",
      claimId: "claim-wrong-child",
      consumerId: "worker-wrong-child",
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(wrongChild, []);
    const exact = await mailbox.claim({
      sessionId: "session-mailbox",
      targetThreadKey: "child-thread",
      targetChildAgentId: "child-1",
      claimId: "claim-exact",
      consumerId: "worker-exact",
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(exact.map((message) => message.message_id), ["active-target-message"]);
  } finally {
    store.close();
  }
});

test("local Agent mailbox claim is single-owner across SQLite store instances", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ragsystem-mailbox-claim-"));
  const dbPath = join(dir, "conversation.db");
  const first = createConversationStore({ dbPath, dataRoot: dir });
  const second = createConversationStore({ dbPath, dataRoot: dir });
  t.after(async () => {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  });
  createSession(first);
  await first.agentMailbox.enqueue({
    messageId: "cross-instance-message",
    tenantId: "tnt_test",
    sessionId: "session-mailbox",
    targetThreadKey: "child-thread",
    kind: "request",
    contentParts: [{ type: "text", text: "one" }],
    availableAt: "2026-01-01T00:00:00.000Z",
  });

  const [left, right] = await Promise.all([
    first.agentMailbox.claim({
      sessionId: "session-mailbox",
      targetThreadKey: "child-thread",
      claimId: "claim-left",
      consumerId: "worker-left",
      now: "2026-01-01T00:00:00.000Z",
    }),
    second.agentMailbox.claim({
      sessionId: "session-mailbox",
      targetThreadKey: "child-thread",
      claimId: "claim-right",
      consumerId: "worker-right",
      now: "2026-01-01T00:00:00.000Z",
    }),
  ]);
  assert.equal(left.length + right.length, 1);
  const owner = left.length === 1 ? first : second;
  const claimId = left.length === 1 ? "claim-left" : "claim-right";
  const retry = await owner.agentMailbox.claim({
    sessionId: "session-mailbox",
    targetThreadKey: "child-thread",
    claimId,
    consumerId: "worker-retry",
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(retry.length, 1);
  assert.equal(retry[0].attempt_count, 1);
});

test("appendMailboxMessage derives the conversation row and settles the envelope atomically", async () => {
  const store = createStore();
  try {
    const storage = new SqliteRuntimeStorage("tnt_test", store);
    const session = {
      sessionId: "session-mailbox",
      ownerUserId: "usr_test",
      visibility: "private",
      originType: "direct",
      originId: null,
      originChannel: "web",
      workspaceId: null,
      teamSnapshot,
      metadata: {},
    };
    const envelope = {
      messageId: "slashcmd_cmd_1",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetThreadKey: "root",
      kind: "request",
      inputType: "user_message",
      sourceKind: "user",
      visibleToUser: true,
      sentAt: "2026-01-01T00:00:00.000Z",
      contentParts: [{ type: "text", text: "/help" }],
      metadata: { request_id: "req-1" },
    };
    const first = await storage.operations.appendMailboxMessage({ session, mailboxMessage: envelope });
    assert.equal(first.message.id, "slashcmd_cmd_1");
    assert.equal(first.message.role, "user");
    assert.equal(first.message.metadata.mailbox_message_id, "slashcmd_cmd_1");
    // 无 run 追加不注入 run 归属键（与 startOrAppendRoot 派生形状的唯二差异之一）。
    assert.equal("run_id" in first.message.metadata, false);
    assert.equal("consumed_by_run_id" in first.message.metadata, false);
    assert.equal((await store.agentMailbox.get("session-mailbox", "slashcmd_cmd_1")).status, "acked");
    // 确定性 id 幂等：重复追加不产生第二行、不换 seq。
    const second = await storage.operations.appendMailboxMessage({ session, mailboxMessage: envelope });
    assert.equal(second.message.seq, first.message.seq);
    const messages = store.getRecentMessages("session-mailbox", 10, "root");
    assert.equal(messages.filter((message) => message.id === "slashcmd_cmd_1").length, 1);
  } finally {
    store.close();
  }
});

test("claim dead-letters queued rows that exhausted delivery attempts", async () => {
  const store = createStore();
  try {
    const mailbox = store.agentMailbox;
    await mailbox.enqueue({ messageId: "poison", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "root", kind: "request", availableAt: "2026-01-01T00:00:00.000Z" });
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const claimed = await mailbox.claim({ sessionId: "session-mailbox", targetThreadKey: "root", claimId: `claim-${attempt}`, consumerId: "worker", now: "2026-01-01T00:00:00.000Z" });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].attempt_count, attempt);
      await mailbox.release({ sessionId: "session-mailbox", messageId: "poison", claimId: `claim-${attempt}`, availableAt: "2026-01-01T00:00:00.000Z", lastError: "boom" });
    }
    const dead = await mailbox.claim({ sessionId: "session-mailbox", targetThreadKey: "root", claimId: "claim-final", consumerId: "worker", now: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(dead, []);
    const row = await mailbox.get("session-mailbox", "poison");
    assert.equal(row.status, "expired");
    assert.equal(row.last_error, "max delivery attempts exceeded");
    // 死信行不再进入滞留会话扫描（触发闭环兜底不复活死信）。
    const pendingSessions = await mailbox.listPendingSessions({ now: "2026-01-01T00:00:00.000Z" });
    assert.equal(pendingSessions.includes("session-mailbox"), false);
  } finally {
    store.close();
  }
});

test("listPendingSessions reports only sessions with claimable queued rows", async () => {
  const store = createStore();
  try {
    store.createSession({
      tenantId: "tnt_test",
      sessionId: "session-mailbox-2",
      ownerUserId: "usr_test",
      visibility: "private",
      originType: "direct",
      originId: null,
      originChannel: "web",
      workspaceId: null,
      teamSnapshot,
      metadata: {},
      permissionMode: null,
    });
    const mailbox = store.agentMailbox;
    await mailbox.enqueue({ messageId: "row-1", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "root", kind: "request", availableAt: "2026-01-01T00:00:00.000Z" });
    await mailbox.enqueue({ messageId: "row-2", tenantId: "tnt_test", sessionId: "session-mailbox-2", targetThreadKey: "root", kind: "request", availableAt: "2026-01-01T00:00:00.000Z" });
    await mailbox.enqueue({ messageId: "row-3", tenantId: "tnt_test", sessionId: "session-mailbox-2", targetThreadKey: "root", kind: "request", availableAt: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(await mailbox.listPendingSessions({ now: "2026-01-01T00:00:00.000Z" }), ["session-mailbox", "session-mailbox-2"]);
    await mailbox.settle({ sessionId: "session-mailbox", messageId: "row-1" });
    assert.deepEqual(await mailbox.listPendingSessions({ now: "2026-01-01T00:00:00.000Z" }), ["session-mailbox-2"]);
  } finally {
    store.close();
  }
});

test("listPendingSessions covers claimed rows whose lease expired after a crash", async () => {
  const store = createStore();
  try {
    const mailbox = store.agentMailbox;
    await mailbox.enqueue({ messageId: "row-leased", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "root", kind: "request", availableAt: "2026-01-01T00:00:00.000Z" });
    await mailbox.claim({ sessionId: "session-mailbox", targetThreadKey: "root", claimId: "claim-lost", consumerId: "worker-lost", leaseMs: 1000, now: "2026-01-01T00:00:00.000Z" });
    // 租约未过期：正在被处理，不算滞留。
    assert.deepEqual(await mailbox.listPendingSessions({ now: "2026-01-01T00:00:00.500Z" }), []);
    // 租约过期：崩溃残留的 claimed 行也被扫描覆盖（sweep 触发 idle → claim 重置回队消费）。
    assert.deepEqual(await mailbox.listPendingSessions({ now: "2026-01-01T00:00:02.000Z" }), ["session-mailbox"]);
  } finally {
    store.close();
  }
});

test("mailbox root wakeup and user start create only one active root across SQLite stores", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ragsystem-mailbox-root-race-"));
  const dbPath = join(dir, "conversation.db");
  const first = createConversationStore({ dbPath, dataRoot: dir });
  const second = createConversationStore({ dbPath, dataRoot: dir });
  const mailboxStorage = new SqliteRuntimeStorage("tnt_test", first);
  const userStorage = new SqliteRuntimeStorage("tnt_test", second);
  t.after(async () => {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  });
  createSession(first);
  const session = {
    sessionId: "session-mailbox",
    ownerUserId: "usr_test",
    visibility: "private",
    originType: "direct",
    originId: null,
    originChannel: "web",
    workspaceId: null,
    teamSnapshot,
    metadata: {},
  };
  const rootRun = (runId, requestId) => ({
    runId,
    sessionId: "session-mailbox",
    status: "running",
    taskSummary: runId,
    requestId,
    agentName: "orchestrator_agent",
    agentCallId: `${runId}:call`,
    lineageParentCallId: null,
    agentDisplayName: "Orchestrator",
    leaseRootRunId: runId,
    threadKey: "root",
  });

  const [mailboxResult, userResult] = await Promise.allSettled([
    mailboxStorage.operations.startRun({
      session,
      run: rootRun("mailbox-root", "mailbox-request"),
      initialMessage: {
        sessionId: "session-mailbox",
        messageId: "mailbox-root:user",
        role: "user",
        content: "mailbox wakeup",
        contentParts: [{ type: "text", text: "mailbox wakeup" }],
        metadata: { run_id: "mailbox-root" },
        threadKey: "root",
        childAgentId: null,
      },
    }),
    userStorage.operations.startOrAppendRoot({
      session,
      run: rootRun("user-root", "user-request"),
      mailboxMessage: {
        messageId: "user-root:user",
        tenantId: "tnt_test",
        sessionId: "session-mailbox",
        targetThreadKey: "root",
        kind: "request",
        inputType: "user_message",
        sourceKind: "user",
        visibleToUser: true,
        sentAt: new Date().toISOString(),
        contentParts: [{ type: "text", text: "user message" }],
        metadata: { run_id: "user-root" },
      },
      followupPolicy: "queue",
    }),
  ]);

  assert.equal(first.listActiveRootRuns("session-mailbox", 2).length, 1);
  assert.equal(userResult.status, "fulfilled");
  if (mailboxResult.status === "rejected") {
    assert.match(String(mailboxResult.reason), /session already has an active root run/);
  }
  assert.equal(["started", "followup"].includes(userResult.value.kind), true);
});

test("local Agent mailbox existsPending counts queued and claimed rows without an availability window", async () => {
  const store = createStore();
  try {
    await store.agentMailbox.enqueue({
      messageId: "goalcont_goal-1_2",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetThreadKey: "root",
      kind: "request",
      inputType: "goal_continuation",
      sourceKind: "system",
      contentParts: [{ type: "text", text: "<goal-continuation/>" }],
    });
    await store.agentMailbox.enqueue({
      messageId: "bgnotify-task-1",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetThreadKey: "root",
      kind: "request",
      inputType: "system_notification",
      sourceKind: "system",
      contentParts: [{ type: "text", text: "done" }],
    });

    assert.equal(await store.agentMailbox.existsPending({ sessionId: "session-mailbox", inputType: "goal_continuation", targetThreadKey: "root" }), true);
    assert.equal(await store.agentMailbox.existsPending({ sessionId: "session-mailbox", inputType: "user_message" }), false);
    // claimed 行计入：正在消费时不生产新一代（goal 循环由该 run 终态续推）。
    await store.agentMailbox.claim({
      sessionId: "session-mailbox",
      targetThreadKey: "root",
      claimId: "claim-exists",
      consumerId: "worker",
    });
    assert.equal(await store.agentMailbox.existsPending({ sessionId: "session-mailbox", inputType: "goal_continuation", targetThreadKey: "root" }), true);
    await store.agentMailbox.settle({ sessionId: "session-mailbox", messageId: "goalcont_goal-1_2" });
    assert.equal(await store.agentMailbox.existsPending({ sessionId: "session-mailbox", inputType: "goal_continuation", targetThreadKey: "root" }), false);
    assert.equal(await store.agentMailbox.existsPending({ sessionId: "session-mailbox" }), true);
  } finally {
    store.close();
  }
});

test("local Agent mailbox rejects a session-internal id reuse under a different tenant", async () => {
  const store = createStore();
  try {
    await store.agentMailbox.enqueue({
      messageId: "bgnotify-task-1",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetThreadKey: "root",
      kind: "request",
      contentParts: [{ type: "text", text: "original" }],
    });
    // 同会话同 id 异租户：消费侧按 session_id 查询不看租户，双行会重复投递，
    // 必须显式冲突（跨会话的同 id 异租户仍是合法租户隔离）。
    await assert.rejects(() => store.agentMailbox.enqueue({
      messageId: "bgnotify-task-1",
      tenantId: "tnt_wrong",
      sessionId: "session-mailbox",
      targetThreadKey: "root",
      kind: "request",
      contentParts: [{ type: "text", text: "misrouted" }],
    }), /already belongs to tenant tnt_test in this session/);
    assert.equal((await store.agentMailbox.get("session-mailbox", "bgnotify-task-1")).content_parts[0].text, "original");
  } finally {
    store.close();
  }
});
