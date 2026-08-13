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

test("runtime start atomically creates a child Run and its real message boundary", async () => {
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

    store.addRunStep({
      sessionId: sessionIdentity.sessionId,
      runId: "child-run",
      eventId: "child-event-1",
      stepType: "protocol.envelope.v1",
      payload: { type: "agent_started", call_id: "child-call" },
    });
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
    store.addRunStep({
      sessionId: sessionIdentity.sessionId,
      runId: "child-run",
      eventId: "child-boundary",
      stepType: "protocol.envelope.v1",
      payload: { type: "agent_message", call_id: "boundary" },
      boundaryMessageId: "child-followup",
      boundaryKind: "carrier",
    });
    store.addRunStep({
      sessionId: sessionIdentity.sessionId,
      runId: "child-run",
      eventId: "child-event-2",
      stepType: "protocol.envelope.v1",
      payload: { type: "tool_call", call_id: "child-tool" },
    });

    assert.deepEqual(
      store.listMessageRunSteps({
        sessionId: sessionIdentity.sessionId,
        runId: "child-run",
        messageId: "child-message",
        limit: 50,
        offset: 0,
      }).items.map(step => step.payload.call_id),
      ["child-call"],
    );
    assert.deepEqual(
      store.listMessageRunSteps({
        sessionId: sessionIdentity.sessionId,
        runId: "child-run",
        messageId: "child-followup",
        limit: 50,
        offset: 0,
      }).items.map(step => step.payload.call_id),
      ["child-tool"],
    );

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

test("followup rollback truncates run steps from its message boundary", () => {
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
    store.ensureInitialRunMessageBoundary("session-1", "root-run", initial.id);
    for (const [eventId, payload, boundaryMessageId, boundaryKind] of [
      ["event-1", { type: "agent_started", call_id: "call-1" }],
      ["event-2", { type: "agent_message", call_id: "boundary", payload: { message_id: "followup-1" } }, "followup-1", "carrier"],
      ["event-3", { type: "tool_call", call_id: "call-2" }],
      ["event-4", { type: "stream_output", message_id: "assistant-1", call_id: "final", payload: { phase: "final" } }, "assistant-1", "terminal"],
    ]) {
      store.addRunStep({
        runId: "root-run",
        sessionId: "session-1",
        eventId,
        stepType: "protocol.envelope.v1",
        payload,
        ...(boundaryMessageId ? { boundaryMessageId, boundaryKind } : {}),
      });
    }
    assert.deepEqual(
      store.listMessageRunSteps({ sessionId: "session-1", runId: "root-run", messageId: initial.id, limit: 50, offset: 0 })
        .items.map(step => step.payload.call_id),
      ["call-1"],
    );
    assert.deepEqual(
      store.listMessageRunSteps({ sessionId: "session-1", runId: "root-run", messageId: "followup-1", limit: 50, offset: 0 })
        .items.map(step => step.payload.call_id),
      ["call-2"],
    );
    assert.equal(
      store.listMessageRunSteps({ sessionId: "session-1", runId: "root-run", messageId: "assistant-1", limit: 50, offset: 0 }).total,
      0,
    );
    const deleted = store.deleteMessagesAfter("session-1", {
      afterSeq: initial.seq,
      truncateRunSteps: { runId: "root-run", fromStepOrder: 2 },
    });

    assert.equal(deleted, 2);
    assert.deepEqual(store.listRunSteps({ sessionId: "session-1", runId: "root-run" }).map(step => step.step_order), [1]);
    const next = store.addRunStep({
      runId: "root-run",
      sessionId: "session-1",
      eventId: "event-5",
      stepType: "protocol.envelope.v1",
      payload: { type: "model_request", call_id: "call-3" },
    });
    assert.equal(next.step_order, 5);
    assert.deepEqual(store.listRunSteps({ sessionId: "session-1", runId: "root-run" }).map(step => step.step_order), [1, 5]);
    assert.deepEqual(store.listMessages("session-1").items.map(message => message.id), [initial.id]);
  } finally {
    store.close();
  }
});
