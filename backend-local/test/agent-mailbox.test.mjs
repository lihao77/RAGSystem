import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";

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
    metadata: {},
    permissionMode: null,
  });
}

function createStore() {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  createSession(store);
  return store;
}

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

    const reclaimed = await mailbox.claim({ sessionId: "session-mailbox", targetRunId: "run-active", targetThreadKey: "child-thread", targetChildAgentId: "child-1", claimId: "claim-2", consumerId: "worker-2", now: "2026-01-01T00:00:02.000Z" });
    assert.deepEqual(reclaimed.map((message) => message.message_id), ["message-1"]);
    assert.equal(reclaimed[0].attempt_count, 2);
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
    await mailbox.enqueue({ messageId: "message-expired", tenantId: "tnt_test", sessionId: "session-mailbox", targetThreadKey: "child-thread", kind: "cancel", expiresAt: "2026-01-01T00:00:01.000Z" });
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

test("local Agent mailbox active claims fence the complete target tuple", async () => {
  const store = createStore();
  try {
    const mailbox = store.agentMailbox;
    await mailbox.enqueue({
      messageId: "active-target-message",
      tenantId: "tnt_test",
      sessionId: "session-mailbox",
      targetRunId: "run-active",
      targetAgentCallId: "call-active",
      targetThreadKey: "child-thread",
      targetChildAgentId: "child-1",
      kind: "result",
      contentParts: [{ type: "text", text: "terminal" }],
      availableAt: "2026-01-01T00:00:00.000Z",
    });
    const wrongThread = await mailbox.claim({
      sessionId: "session-mailbox",
      targetRunId: "run-active",
      targetAgentCallId: "call-active",
      targetThreadKey: "other-thread",
      targetChildAgentId: "child-1",
      claimId: "claim-wrong-thread",
      consumerId: "worker-wrong-thread",
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(wrongThread, []);
    const wrongChild = await mailbox.claim({
      sessionId: "session-mailbox",
      targetRunId: "run-active",
      targetAgentCallId: "call-active",
      targetThreadKey: "child-thread",
      targetChildAgentId: "child-2",
      claimId: "claim-wrong-child",
      consumerId: "worker-wrong-child",
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(wrongChild, []);
    const exact = await mailbox.claim({
      sessionId: "session-mailbox",
      targetRunId: "run-active",
      targetAgentCallId: "call-active",
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
