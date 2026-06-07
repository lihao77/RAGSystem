import { describe, expect, it } from "vitest";

import type { OutboxRow } from "../../src/services/stores/conversation-store/types.js";
import { ConversationStore } from "../../src/services/stores/conversation-store.js";
import { InMemoryEventBus } from "../../src/services/runtime/event-bus.js";
import { ClientEventProjector } from "../../src/services/runtime/event-outbox/projector.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";

describe("event outbox projection and dispatch", () => {
  it("projects completed terminal outbox rows to client events in protocol order", () => {
    const projector = new ClientEventProjector();
    const rows = completedRows();

    const projected = rows.map((row) => projector.toClientEvent(row));

    expect(projected.map((event) => event.type)).toEqual([
      "execution.step",
      "output.final_answer",
      "call.agent.end",
      "execution.step",
      "output.message_saved",
      "run.end",
    ]);
    expect(projected[0]).toMatchObject({
      event_id: "event-1",
      event_seq: 1,
      data: { kind: "final", phase: "complete" },
    });
    expect(projected[2]).toMatchObject({
      agent_name: "orchestrator_agent",
      call_id: "call-root",
      data: {
        agent_display_name: "Orchestrator Agent",
        success: true,
      },
    });
    expect(projected[5]).toMatchObject({
      data: {
        status: "completed",
        final_message_id: "msg-1",
      },
    });
  });

  it("projects failed terminal outbox rows to client events in protocol order", () => {
    const projector = new ClientEventProjector();
    const rows = failedRows("run.failed", "failed");

    const projected = rows.map((row) => projector.toClientEvent(row));

    expect(projected.map((event) => event.type)).toEqual([
      "call.agent.end",
      "execution.step",
      "agent.error",
      "run.end",
    ]);
    expect(projected[2]).toMatchObject({
      agent_name: "orchestrator_agent",
      call_id: "call-root",
      error: "provider failed",
      data: {
        error_type: "ExecutionError",
      },
    });
    expect(projected[3]).toMatchObject({
      data: {
        status: "failed",
        error: "provider failed",
      },
    });
  });

  it("runs dispatcher in shadow mode without publishing to the event bus", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    const events = new InMemoryEventBus();
    store.createSession("s1");
    store.appendOutbox({
      sessionId: "s1",
      runId: "run-1",
      eventId: "event-1",
      eventType: "run.completed",
      aggregateType: "run",
      aggregateId: "run-1",
      payload: {
        final_message_id: "msg-1",
        metadata: { run_id: "run-1" },
      },
    });

    const dispatcher = new OutboxDispatcher(store, events);
    const projected = dispatcher.pollOnce();

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      type: "run.end",
      event_id: "event-1",
      event_seq: 1,
    });
    expect(store.fetchPendingOutbox(10)).toEqual([]);
    expect(events.getHistory("s1")).toEqual([]);
    expect(dispatcher.getMetrics()).toMatchObject({
      projected: 1,
      delivered: 1,
      failed: 0,
    });
    store.close();
  });

  it("publishes projected events in live mode", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    const events = new InMemoryEventBus();
    store.createSession("s1");
    store.appendOutbox({
      sessionId: "s1",
      runId: "run-1",
      eventId: "event-1",
      eventType: "run.completed",
      aggregateType: "run",
      aggregateId: "run-1",
      payload: {
        final_message_id: "msg-1",
        metadata: { run_id: "run-1" },
      },
    });

    const dispatcher = new OutboxDispatcher(store, events, undefined, "live");
    dispatcher.pollOnce();

    expect(events.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run.end",
        event_id: "event-1",
        event_seq: 1,
      }),
    ]);
    store.close();
  });
});

function completedRows(): OutboxRow[] {
  return [
    row(1, "execution.step_recorded", { step: { kind: "final", phase: "complete", run_id: "run-1" } }),
    row(2, "run.final_answer_recorded", { content: "answer", metadata: { run_id: "run-1" }, message_id: "msg-1" }, "msg-1"),
    row(3, "agent.call_finished", {
      agent_name: "orchestrator_agent",
      agent_display_name: "Orchestrator Agent",
      call_id: "call-root",
      result: "answer",
      success: true,
      task_id: "task-1",
      request_id: "req-1",
    }),
    row(4, "execution.step_recorded", { step: { kind: "run", phase: "end", status: "completed", run_id: "run-1" } }),
    row(5, "message.saved", { message_id: "msg-1", seq: 2, role: "assistant", task_id: "task-1", request_id: "req-1" }, "msg-1"),
    row(6, "run.completed", { final_message_id: "msg-1", metadata: { run_id: "run-1" } }),
  ];
}

function failedRows(eventType: "run.failed" | "run.interrupted", status: "failed" | "interrupted"): OutboxRow[] {
  return [
    row(1, "agent.call_finished", {
      agent_name: "orchestrator_agent",
      agent_display_name: "Orchestrator Agent",
      call_id: "call-root",
      result: "provider failed",
      success: false,
      task_id: "task-1",
      request_id: "req-1",
    }),
    row(2, "execution.step_recorded", { step: { kind: "run", phase: "end", status: "error", run_id: "run-1" } }),
    row(3, "run.error_reported", {
      agent_name: "orchestrator_agent",
      call_id: "call-root",
      error: "provider failed",
      error_type: "ExecutionError",
      task_id: "task-1",
      request_id: "req-1",
    }),
    row(4, eventType, { status, error: "provider failed", metadata: { run_id: "run-1" } }),
  ];
}

function row(sessionSeq: number, eventType: string, payload: Record<string, unknown>, aggregateId = "run-1"): OutboxRow {
  return {
    id: sessionSeq,
    event_id: `event-${sessionSeq}`,
    session_id: "s1",
    run_id: "run-1",
    session_seq: sessionSeq,
    event_type: eventType,
    aggregate_type: aggregateId === "run-1" ? "run" : "message",
    aggregate_id: aggregateId,
    payload: JSON.stringify(payload),
    status: "pending",
    attempts: 0,
    available_at: null,
    locked_at: null,
    delivered_at: null,
    last_error: null,
    created_at: "2026-06-07T00:00:00.000Z",
  };
}
