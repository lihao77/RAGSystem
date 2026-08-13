import assert from "node:assert/strict";
import test from "node:test";

import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";
import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";

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
