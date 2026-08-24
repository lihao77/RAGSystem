import assert from "node:assert/strict";
import test from "node:test";

import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";
import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { SqliteRuntimeStorage } from "../dist/adapters/local/sqlite-runtime-storage.js";

const teamSnapshot = (() => {
  const agents = { assistant: { agent_name: "assistant" } };
  return {
    team_name: "default",
    team_revision: computeSessionTeamRevision(agents),
    entry_agent_name: "assistant",
    agents,
  };
})();

const sessionIdentity = {
  sessionId: "session-atomic",
  ownerUserId: "usr_test",
  visibility: "private",
  originType: "direct",
  originId: null,
  originChannel: "web",
  workspaceId: null,
  teamSnapshot,
  metadata: {},
};

const runInput = (runId, parentRunId, threadKey, childAgentId = null) => ({
  runId,
  sessionId: sessionIdentity.sessionId,
  status: "running",
  taskSummary: runId,
  requestId: `${runId}:request`,
  agentName: "assistant",
  agentCallId: `${runId}:call`,
  lineageParentCallId: parentRunId ? "root-run:call" : null,
  agentDisplayName: "Assistant",
  leaseRootRunId: parentRunId ? runId : "root-run",
  threadKey,
  parentRunId,
  parentCallId: parentRunId ? "root-run:call" : null,
  childAgentId,
});

const initialMessage = (messageId, runId, threadKey, childAgentId = null) => ({
  sessionId: sessionIdentity.sessionId,
  messageId,
  role: "user",
  content: messageId,
  contentParts: [{ type: "text", text: messageId }],
  metadata: { run_id: runId, child_agent_id: childAgentId },
  threadKey,
  childAgentId,
});

test("runtime start atomically creates a child Run and its initial message", async () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  const runtime = new SqliteRuntimeStorage("tnt_test", store);
  try {
    await runtime.operations.startRun({
      session: sessionIdentity,
      run: runInput("root-run", null, "root"),
      initialMessage: initialMessage("root-message", "root-run", "root"),
    });
    await runtime.operations.startRun({
      session: sessionIdentity,
      run: runInput("child-run", "root-run", "child:child-1", "child-1"),
      initialMessage: initialMessage("child-message", "child-run", "child:child-1", "child-1"),
      claimOwnLease: true,
    });

    const persisted = store.getMessageById(sessionIdentity.sessionId, "child-message");
    assert.equal(persisted?.thread_key, "child:child-1");
    assert.equal(persisted?.child_agent_id, "child-1");
    assert.equal(store.getRun(sessionIdentity.sessionId, "child-run")?.parent_run_id, "root-run");

    store.addMessage({
      sessionId: sessionIdentity.sessionId,
      messageId: "child-followup",
      role: "user",
      content: "continue",
      contentParts: [{ type: "text", text: "continue" }],
      metadata: { consumed_by_run_id: "child-run", run_id: "child-run" },
      threadKey: "child:child-1",
      childAgentId: "child-1",
    });

    await assert.rejects(
      runtime.operations.startRun({
        session: sessionIdentity,
        run: runInput("child-without-message", "root-run", "child:child-2", "child-2"),
        claimOwnLease: true,
      }),
      /new run requires an initial message/,
    );
    assert.equal(store.getRun(sessionIdentity.sessionId, "child-without-message"), null);

    await runtime.operations.startRun({
      session: sessionIdentity,
      run: runInput("child-run", "root-run", "child:child-1", "child-1"),
      claimOwnLease: true,
    });
    assert.equal(store.listMessages(sessionIdentity.sessionId, Number.MAX_SAFE_INTEGER, 0, "child:child-1").total, 2);
  } finally {
    store.close();
  }
});

test("runtime atomically commits a mailbox input message, outbox, and ACK", async () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  const runtime = new SqliteRuntimeStorage("tnt_test", store);
  try {
    await runtime.operations.startRun({
      session: sessionIdentity,
      run: runInput("root-run", null, "root"),
      initialMessage: initialMessage("root-message", "root-run", "root"),
    });
    await store.agentMailbox.enqueue({
      messageId: "followup-atomic",
      tenantId: "tnt_test",
      sessionId: sessionIdentity.sessionId,
      targetRunId: "root-run",
      targetAgentCallId: "root-run:call",
      targetThreadKey: "root",
      kind: "request",
      inputType: "user_message",
      sourceKind: "user",
      visibleToUser: true,
      contentParts: [{ type: "text", text: "follow up" }],
    });
    const [claimed] = await store.agentMailbox.claim({
      sessionId: sessionIdentity.sessionId,
      targetRunId: "root-run",
      targetAgentCallId: "root-run:call",
      targetThreadKey: "root",
      claimId: "claim-atomic",
      consumerId: "test",
    });
    assert.ok(claimed);
    const envelope = {
      type: "agent_message",
      protocol_version: "1.0",
      session_id: sessionIdentity.sessionId,
      run_id: "root-run",
      message_id: "followup-atomic",
      payload: { message_id: "followup-atomic" },
    };
    const input = {
      sessionId: sessionIdentity.sessionId,
      runId: "root-run",
      message: {
        sessionId: sessionIdentity.sessionId,
        messageId: "followup-atomic",
        role: "user",
        content: "follow up",
        contentParts: [{ type: "text", text: "follow up" }],
        metadata: { run_id: "root-run", consumed_by_run_id: "root-run" },
        threadKey: "root",
      },
      record: {
        outbox: {
          sessionId: sessionIdentity.sessionId,
          runId: "root-run",
          eventId: "root-run:input:followup-atomic",
          eventType: "client.agent_message",
          aggregateType: "run",
          aggregateId: "root-run",
          payload: { client_event: envelope },
        },
        requireRunLease: true,
      },
      mailboxAck: {
        sessionId: sessionIdentity.sessionId,
        messageId: "followup-atomic",
        claimId: "claim-atomic",
      },
    };
    const committed = await runtime.operations.commitRunInput(input);
    assert.equal(committed.mailboxAcked, true);
    // outbox 信封携带消息的 canonical 会话序号（同事务消息序列回填）。
    assert.equal(
      JSON.parse(committed.record.outbox.payload).client_event.payload.seq,
      committed.message.seq,
    );
    assert.equal((await store.agentMailbox.get(sessionIdentity.sessionId, "followup-atomic"))?.status, "acked");

    // 幂等重试：outbox eventId 去重，不产生第二行。
    const retried = await runtime.operations.commitRunInput(input);
    assert.equal(retried.record.outbox.event_id, committed.record.outbox.event_id);
  } finally {
    store.close();
  }
});

test("runtime start publishes the initial message with its canonical conversation sequence", async () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  const runtime = new SqliteRuntimeStorage("tnt_test", store);
  try {
    const message = initialMessage("root-message", "root-run", "root");
    const envelope = {
      type: "state_sync",
      session_id: sessionIdentity.sessionId,
      run_id: "root-run",
      payload: {
        category: "message_saved",
        ref: {
          message_id: message.messageId,
          role: "user",
          content_parts: message.contentParts,
        },
      },
    };
    const started = await runtime.operations.startRun({
      session: sessionIdentity,
      run: runInput("root-run", null, "root"),
      initialMessage: message,
      initialRecords: [{
        outbox: {
          sessionId: sessionIdentity.sessionId,
          runId: "root-run",
          eventId: "root-run:initial:message_saved",
          eventType: "client.state_sync",
          aggregateType: "run",
          aggregateId: "root-run",
          payload: { client_event: envelope },
        },
      }],
    });

    const persisted = store.getMessageById(sessionIdentity.sessionId, message.messageId);
    assert.ok(persisted);
    assert.equal(
      JSON.parse(started.records[0].outbox.payload).client_event.payload.ref.seq,
      persisted.seq,
    );
  } finally {
    store.close();
  }
});

test("recordEnvelope commits envelopes to the outbox without a step archive", async () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  const runtime = new SqliteRuntimeStorage("tnt_test", store);
  try {
    await runtime.operations.startRun({
      session: sessionIdentity,
      run: runInput("root-run", null, "root"),
      initialMessage: initialMessage("root-message", "root-run", "root"),
    });
    const recorded = [];
    for (const [index, type] of ["agent_started", "model_request"].entries()) {
      const envelope = {
        type,
        session_id: sessionIdentity.sessionId,
        run_id: "root-run",
        call_id: "root-run:call",
        agent_id: "assistant",
        payload: { phase: "start" },
      };
      const result = await runtime.operations.recordEnvelope({
        outbox: {
          sessionId: sessionIdentity.sessionId,
          runId: "root-run",
          eventId: `root-event-${index + 1}`,
          eventType: `client.${type}`,
          aggregateType: "run",
          aggregateId: "root-run",
          payload: { client_event: envelope },
        },
      });
      recorded.push(result.outbox.event_id);
      // run_steps 归档退役：记录只含 outbox 产物。
      assert.equal("step" in result, false);
    }
    assert.deepEqual(recorded, ["root-event-1", "root-event-2"]);

    // 幂等重放：同 eventId 返回已存在行，不重复投递。
    const again = await runtime.operations.recordEnvelope({
      outbox: {
        sessionId: sessionIdentity.sessionId,
        runId: "root-run",
        eventId: "root-event-1",
        eventType: "client.agent_started",
        aggregateType: "run",
        aggregateId: "root-run",
        payload: { client_event: { type: "agent_started", session_id: sessionIdentity.sessionId, run_id: "root-run", call_id: "root-run:call", agent_id: "assistant", payload: { phase: "start" } } },
      },
    });
    assert.equal(again.outbox.event_id, "root-event-1");
  } finally {
    store.close();
  }
});

test("rollback deletes messages after the anchor and keeps run rows intact", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    const agents = { assistant: { agent_name: "assistant" } };
    store.createSession({
      sessionId: "session-1",
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
    const initial = store.addMessage({
      sessionId: "session-1",
      role: "user",
      content: "initial",
      contentParts: [{ type: "text", text: "initial" }],
      metadata: { run_id: "root-run" },
      threadKey: "root",
    });
    store.addMessage({
      sessionId: "session-1",
      role: "assistant",
      content: "intermediate",
      contentParts: [{ type: "text", text: "intermediate" }],
      metadata: { hidden: true },
      threadKey: "root",
    });
    store.addMessage({
      sessionId: "session-1",
      role: "user",
      content: "followup",
      contentParts: [{ type: "text", text: "followup" }],
      metadata: { run_id: "root-run", source: "running_session", execution_kind: "session_followup" },
      messageId: "followup-1",
      threadKey: "root",
    });
    store.addMessage({
      sessionId: "session-1",
      role: "assistant",
      content: "done",
      contentParts: [{ type: "text", text: "done" }],
      metadata: { run_id: "root-run" },
      threadKey: "root",
    });
    store.createRun({
      runId: "root-run",
      sessionId: "session-1",
      entrypoint: "agent_stream",
      status: "completed",
      taskSummary: "initial",
      agentCallId: "root-call",
      lineageParentCallId: null,
      agentDisplayName: "assistant",
      leaseRootRunId: "root-run",
      threadKey: "root",
    });
    const deleted = store.deleteMessagesAfter("session-1", {
      afterSeq: initial.seq,
    });

    assert.equal(deleted, 3);
    assert.deepEqual(store.listMessages("session-1").items.map(message => message.id), [initial.id]);
    // run 行保留：执行视图/结果重建的数据源（runs.terminal_reason）不受回滚影响。
    assert.equal(store.getRun("session-1", "root-run")?.status, "completed");
  } finally {
    store.close();
  }
});
