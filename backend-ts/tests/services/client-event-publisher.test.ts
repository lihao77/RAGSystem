import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { SqliteRuntimeStorage } from "../../src/adapters/local/sqlite-runtime-storage.js";
import {
  buildExecutionEnvelopeRunStep,
  EXECUTION_ENVELOPE_STEP_TYPE,
} from "../../src/services/runtime/event-outbox/execution-envelope-archive.js";

describe("client event persistence", () => {
  it("builds an execution step without performing persistence", () => {
    expect(buildExecutionEnvelopeRunStep("session-1", "run-1", {
      type: "tool_call",
      session_id: "wrong-session",
      run_id: "wrong-run",
      payload: { tool: "read_file", phase: "start" },
    }, "event-1")).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      eventId: "event-1",
      stepType: EXECUTION_ENVELOPE_STEP_TYPE,
      payload: expect.objectContaining({
        protocol_version: "1.0",
        session_id: "session-1",
        run_id: "run-1",
      }),
    });
    expect(buildExecutionEnvelopeRunStep("session-1", "run-1", {
      type: "run_ended",
      session_id: "session-1",
      run_id: "run-1",
      payload: { status: "completed" },
    }, "event-2")).toBeNull();
  });

  it("uses one generated event id for the archived step and outbox row", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "session-1", ownerUserId: "user-1", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
      store.createRun({ runId: "run-1", sessionId: "session-1" });
      const dispatched: number[][] = [];
      const publisher = new DurableClientEventPublisher(new SqliteRuntimeStorage(LOCAL_TENANT_ID, store), {
        dispatchRows: async (rows) => {
          dispatched.push(rows.map((row) => row.id));
          return [];
        },
      });

      const row = await publisher.publish("session-1", {
        type: "stream_output",
        session_id: "session-1",
        run_id: "run-1",
        payload: { phase: "delta", content: "answer" },
      });
      const [step] = store.listRunSteps({ sessionId: "session-1", runId: "run-1" });
      const replayedStep = store.addRunStep({
        sessionId: "session-1",
        runId: "run-1",
        eventId: row.event_id,
        stepType: EXECUTION_ENVELOPE_STEP_TYPE,
        payload: {},
      });

      expect(row.event_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(replayedStep).toMatchObject({ id: step?.id, event_id: row.event_id });
      expect(store.listRunSteps({ sessionId: "session-1", runId: "run-1" })).toHaveLength(1);
      expect(dispatched).toEqual([[row.id]]);
    } finally {
      store.close();
    }
  });
});
