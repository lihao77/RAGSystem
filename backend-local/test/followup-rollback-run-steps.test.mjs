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

test("runtime atomically commits a mailbox input message, boundary, outbox, and ACK", async () => {
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
        step: {
          sessionId: sessionIdentity.sessionId,
          runId: "root-run",
          stepType: "protocol.envelope.v1",
          boundaryMessageId: "followup-atomic",
          boundaryKind: "carrier",
          payload: envelope,
        },
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
    const [persistedStep] = store.listRunSteps({
      sessionId: sessionIdentity.sessionId,
      runId: "root-run",
    });
    assert.equal(persistedStep.payload.payload.seq, committed.message.seq);
    assert.equal(
      JSON.parse(committed.record.outbox.payload).client_event.payload.seq,
      committed.message.seq,
    );
    assert.equal((await store.agentMailbox.get(sessionIdentity.sessionId, "followup-atomic"))?.status, "acked");
    assert.equal(store.getRunMessageBoundary(sessionIdentity.sessionId, "root-run", "followup-atomic"), 1);

    const retried = await runtime.operations.commitRunInput(input);
    assert.equal(retried.record.step?.step_order, committed.record.step?.step_order);
    assert.equal(store.listRunSteps({ sessionId: sessionIdentity.sessionId, runId: "root-run" }).length, 1);
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

test("presentation targets do not create duplicate durable message boundaries", async () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  const runtime = new SqliteRuntimeStorage("tnt_test", store);
  try {
    await runtime.operations.startRun({
      session: sessionIdentity,
      run: runInput("root-run", null, "root"),
      initialMessage: initialMessage("root-message", "root-run", "root"),
    });
    for (const [index, type] of ["agent_started", "model_request"].entries()) {
      const envelope = {
        type,
        session_id: sessionIdentity.sessionId,
        run_id: "root-run",
        call_id: "root-run:call",
        agent_id: "assistant",
        boundary_message_id: "root-message",
        payload: { phase: "start" },
      };
      await runtime.operations.recordEnvelope({
        step: {
          sessionId: sessionIdentity.sessionId,
          runId: "root-run",
          stepType: "protocol.envelope.v1",
          payload: envelope,
        },
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
    }

    assert.deepEqual(
      store.listMessageRunSteps({
        sessionId: sessionIdentity.sessionId,
        runId: "root-run",
        messageId: "root-message",
        limit: 50,
        offset: 0,
      }).items.map(step => step.payload.type),
      ["agent_started", "model_request"],
    );
  } finally {
    store.close();
  }
});

test("rollback derives run-step truncation from every deleted message boundary", () => {
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
    store.ensureInitialRunMessageBoundary("session-1", "root-run", initial.id);
    for (const [eventId, payload, boundaryMessageId, boundaryKind] of [
      ["event-1", { type: "agent_started", call_id: "call-1" }],
      ["event-2", { type: "agent_message", call_id: "boundary", payload: { message_id: "followup-1" } }, "followup-1", "carrier"],
      ["event-3", { type: "tool_call", call_id: "call-2" }],
      ["event-4", { type: "stream_output", message_id: "assistant-1", call_id: "final", payload: { phase: "final" } }, "assistant-1", "terminal"],
      ["event-5", { type: "agent_ended", call_id: "root-call", payload: { phase: "end" } }],
      ["event-6", { type: "run_ended", payload: { status: "completed" } }],
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
        .items.map(step => step.payload.type),
      ["tool_call", "stream_output", "agent_ended", "run_ended"],
    );
    assert.equal(
      store.listMessageRunSteps({ sessionId: "session-1", runId: "root-run", messageId: "assistant-1", limit: 50, offset: 0 }).total,
      0,
    );
    const deleted = store.deleteMessagesAfter("session-1", {
      afterSeq: initial.seq,
    });

    assert.equal(deleted, 3);
    assert.deepEqual(store.listRunSteps({ sessionId: "session-1", runId: "root-run" }).map(step => step.step_order), [1]);
    const next = store.addRunStep({
      runId: "root-run",
      sessionId: "session-1",
      eventId: "event-7",
      stepType: "protocol.envelope.v1",
      payload: { type: "model_request", call_id: "call-3" },
    });
    assert.equal(next.step_order, 7);
    assert.deepEqual(store.listRunSteps({ sessionId: "session-1", runId: "root-run" }).map(step => step.step_order), [1, 7]);
    assert.deepEqual(store.listMessages("session-1").items.map(message => message.id), [initial.id]);
  } finally {
    store.close();
  }
});

test("one rollback truncates multiple surviving Runs at their earliest deleted boundary", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    store.createSession({ ...sessionIdentity, tenantId: "tnt_test", permissionMode: null });
    for (const [runId, threadKey, childAgentId] of [
      ["root-run", "root", null],
      ["child-run", "child:child-1", "child-1"],
    ]) {
      store.createRun({
        runId, sessionId: sessionIdentity.sessionId, entrypoint: "agent_stream", status: "running",
        taskSummary: runId, agentCallId: `${runId}:call`, lineageParentCallId: null,
        agentDisplayName: "assistant", leaseRootRunId: runId, threadKey, childAgentId,
      });
      const initial = store.addMessage({
        sessionId: sessionIdentity.sessionId, role: "user", content: `${runId}:initial`,
        contentParts: [{ type: "text", text: `${runId}:initial` }],
        metadata: { run_id: runId }, threadKey, childAgentId,
      });
      store.ensureInitialRunMessageBoundary(sessionIdentity.sessionId, runId, initial.id);
      store.addRunStep({
        sessionId: sessionIdentity.sessionId, runId, eventId: `${runId}:before`,
        stepType: "protocol.envelope.v1", payload: { type: "agent_started", call_id: `${runId}:before` },
      });
    }
    const anchor = store.getMessageById(sessionIdentity.sessionId, store.listMessages(sessionIdentity.sessionId).items[1].id);
    assert.ok(anchor);
    for (const [runId, threadKey, childAgentId] of [
      ["root-run", "root", null],
      ["child-run", "child:child-1", "child-1"],
    ]) {
      const followup = store.addMessage({
        sessionId: sessionIdentity.sessionId, messageId: `${runId}:followup`, role: "user", content: "continue",
        contentParts: [{ type: "text", text: "continue" }], metadata: { consumed_by_run_id: runId },
        threadKey, childAgentId,
      });
      store.addRunStep({
        sessionId: sessionIdentity.sessionId, runId, eventId: `${runId}:boundary`,
        stepType: "protocol.envelope.v1", payload: { type: "agent_message", message_id: followup.id },
        boundaryMessageId: followup.id, boundaryKind: "carrier",
      });
      store.addRunStep({
        sessionId: sessionIdentity.sessionId, runId, eventId: `${runId}:after`,
        stepType: "protocol.envelope.v1", payload: { type: "tool_call", call_id: `${runId}:after` },
      });
    }

    assert.equal(store.deleteMessagesAfter(sessionIdentity.sessionId, { afterSeq: anchor.seq }), 2);
    for (const runId of ["root-run", "child-run"]) {
      assert.deepEqual(
        store.listRunSteps({ sessionId: sessionIdentity.sessionId, runId }).map(step => step.payload.call_id),
        [`${runId}:before`],
      );
    }
  } finally {
    store.close();
  }
});
