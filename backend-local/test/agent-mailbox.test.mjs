import assert from "node:assert/strict";
import test from "node:test";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";

function createStore() {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
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
