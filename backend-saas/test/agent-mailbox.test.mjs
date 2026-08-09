import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAgentMailboxRepository } from "../dist/adapters/saas/postgres/agent-mailbox-repository.js";

class FakeExecutor {
  constructor() {
    this.rows = [];
    this.nextSeq = 1;
    this.claimQueries = 0;
  }

  async transaction(fn) {
    return fn(this);
  }

  async query(sql, params = []) {
    if (sql.includes("SELECT") && sql.includes("WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3")) {
      const [tenantId, sessionId, messageId] = params;
      return { rows: this.rows.filter((row) => row.tenant_id === tenantId && row.session_id === sessionId && row.message_id === messageId) };
    }
    if (sql.includes("INSERT INTO agent_mailbox_messages")) {
      const [messageId, tenantId, sessionId, sourceRunId, sourceCallId, targetRunId, targetCallId, targetThreadKey, targetChildAgentId, kind, correlationId, replyToMessageId, contentParts, metadata, availableAt, expiresAt] = params;
      const existing = this.rows.find((row) => row.tenant_id === tenantId && row.message_id === messageId);
      if (!existing) {
        const now = new Date().toISOString();
        this.rows.push({
          seq: this.nextSeq++, message_id: messageId, tenant_id: tenantId, session_id: sessionId,
          source_run_id: sourceRunId, source_agent_call_id: sourceCallId,
          target_run_id: targetRunId, target_agent_call_id: targetCallId,
          target_thread_key: targetThreadKey, target_child_agent_id: targetChildAgentId,
          kind, correlation_id: correlationId, reply_to_message_id: replyToMessageId,
          content_parts: JSON.parse(contentParts), metadata: JSON.parse(metadata), status: "queued",
          attempt_count: 0, claim_id: null, claimed_by: null, claim_expires_at: null,
          available_at: availableAt, expires_at: expiresAt, last_error: null,
          created_at: now, updated_at: now, acked_at: null,
        });
      }
      return { rows: [] };
    }
    if (sql.includes("status='claimed' AND claim_id=$3")) {
      const [tenantId, sessionId, claimId] = params;
      return { rows: this.rows.filter((row) => row.tenant_id === tenantId && row.session_id === sessionId && row.status === "claimed" && row.claim_id === claimId) };
    }
    if (sql.includes("WITH picked AS")) {
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      this.claimQueries += 1;
      const limit = Number(params.at(-4));
      const claimId = params.at(-3);
      const consumerId = params.at(-2);
      const claimExpiresAt = params.at(-1);
      const tenantId = params[0];
      const sessionId = params[1];
      const now = params[2];
      const target = sql.match(/target_run_id=\$(\d+) AND target_thread_key=\$(\d+)(?: AND target_agent_call_id=\$(\d+))?(?: AND target_child_agent_id=\$(\d+))?/);
      const picked = this.rows
        .filter((row) => {
          if (row.tenant_id !== tenantId || row.session_id !== sessionId || row.status !== "queued" || row.available_at > now) return false;
          if (!target) return true;
          const runId = params[Number(target[1]) - 1];
          const threadKey = params[Number(target[2]) - 1];
          const callId = target[3] ? params[Number(target[3]) - 1] : null;
          const childId = target[4] ? params[Number(target[4]) - 1] : null;
          return row.target_run_id === runId && row.target_thread_key === threadKey
            && (!callId || row.target_agent_call_id === callId)
            && (!childId || row.target_child_agent_id === childId);
        })
        .sort((left, right) => left.seq - right.seq)
        .slice(0, limit);
      for (const row of picked) {
        row.status = "claimed";
        row.claim_id = claimId;
        row.claimed_by = consumerId;
        row.claim_expires_at = claimExpiresAt;
        row.attempt_count += 1;
      }
      return { rows: picked };
    }
    if (sql.includes("status='expired'")) return { rows: [], rowCount: 0 };
    if (sql.includes("status='queued'")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("UPDATE agent_mailbox_messages SET status='acked'")) {
      const [, sessionId, messageId, claimId] = params;
      const row = this.rows.find((item) => item.tenant_id === params[0] && item.session_id === sessionId && item.message_id === messageId && item.status === "claimed" && item.claim_id === claimId);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "acked";
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected fake query: ${sql}`);
  }
}

function messageInput(overrides = {}) {
  return {
    messageId: "message-1",
    tenantId: "tenant-1",
    sessionId: "session-1",
    sourceRunId: "source-run",
    sourceAgentCallId: "source-call",
    targetRunId: "target-run",
    targetAgentCallId: "target-call",
    targetThreadKey: "child:worker",
    targetChildAgentId: "child-1",
    kind: "request",
    correlationId: "corr-1",
    contentParts: [{ type: "text", text: "hello" }],
    metadata: { source: "test" },
    availableAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("SaaS Agent mailbox fences tenant, target tuple, and claim retry", async () => {
  const executor = new FakeExecutor();
  const mailbox = new PostgresAgentMailboxRepository("tenant-1", executor);

  const created = await mailbox.enqueue(messageInput());
  const duplicate = await mailbox.enqueue(messageInput());
  assert.equal(duplicate.message_id, created.message_id);
  await assert.rejects(() => mailbox.enqueue(messageInput({ expiresAt: "2026-01-01T00:00:01.000Z" })), /conflict/);
  await assert.rejects(() => mailbox.enqueue(messageInput({ tenantId: "tenant-2" })), /tenant mismatch/);

  const wrongTarget = await mailbox.claim({
    sessionId: "session-1", targetRunId: "target-run", targetAgentCallId: "target-call",
    targetThreadKey: "other-thread", targetChildAgentId: "child-1",
    claimId: "claim-wrong", consumerId: "worker-wrong", now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(wrongTarget, []);
  const claimed = await mailbox.claim({
    sessionId: "session-1", targetRunId: "target-run", targetAgentCallId: "target-call",
    targetThreadKey: "child:worker", targetChildAgentId: "child-1",
    claimId: "claim-1", consumerId: "worker-1", now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(claimed.map((item) => item.message_id), ["message-1"]);
  const retry = await mailbox.claim({
    sessionId: "session-1", targetRunId: "different-run", targetAgentCallId: "different-call",
    targetThreadKey: "different-thread", targetChildAgentId: "different-child",
    claimId: "claim-1", consumerId: "worker-1-retry", now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(retry.map((item) => item.message_id), ["message-1"]);
  assert.equal(retry[0].attempt_count, 1);
  assert.equal(executor.claimQueries, 2);
});
