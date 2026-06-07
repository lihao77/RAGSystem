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

  it("publishes projected events to realtime fanout by default", () => {
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
    expect(events.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run.end",
        event_id: "event-1",
        event_seq: 1,
      }),
    ]);
    expect(dispatcher.getMetrics()).toMatchObject({
      projected: 1,
      delivered: 1,
      failed: 0,
    });
    store.close();
  });

  it("marks projected events delivered after realtime fanout", () => {
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

  it("does not retry delivered rows when a realtime subscriber fails", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    const events = new InMemoryEventBus();
    store.createSession("s1");
    events.subscribe("s1", () => {
      throw new Error("websocket send failed");
    });
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
    expect(dispatcher.pollOnce()).toHaveLength(1);

    expect(store.listOutboxForReplay({ sessionId: "s1" })).toEqual([
      expect.objectContaining({
        status: "delivered",
        attempts: 0,
        last_error: null,
      }),
    ]);
    expect(dispatcher.getMetrics()).toMatchObject({
      delivered: 1,
      retried: 0,
      failed: 0,
      lastError: null,
    });
    expect(events.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run.end",
        event_id: "event-1",
      }),
    ]);
    store.close();
  });

  it("retries projection failures with backoff before delivering", () => {
    let nowMs = Date.parse("2026-06-07T00:00:00.000Z");
    const now = () => new Date(nowMs);
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
      availableAt: now().toISOString(),
      payload: {
        final_message_id: "msg-1",
        metadata: { run_id: "run-1" },
      },
    });

    let failProjection = true;
    const projector = new ClientEventProjector();
    const dispatcher = new OutboxDispatcher(
      store,
      events,
      {
        toClientEvent(row: OutboxRow) {
          if (failProjection) {
            throw new Error("projection unavailable");
          }
          return projector.toClientEvent(row);
        },
      } as ClientEventProjector,
      {
        maxAttempts: 3,
        retryBaseDelayMs: 1_000,
        retryMaxDelayMs: 1_000,
        now,
      },
    );

    expect(dispatcher.pollOnce()).toEqual([]);
    expect(store.listOutboxForReplay({ sessionId: "s1" })).toEqual([
      expect.objectContaining({
        status: "retrying",
        attempts: 1,
        available_at: "2026-06-07T00:00:01.000Z",
        locked_at: null,
        last_error: "projection unavailable",
      }),
    ]);
    expect(dispatcher.getMetrics()).toMatchObject({
      delivered: 0,
      retried: 1,
      failed: 0,
      lastError: "projection unavailable",
    });

    failProjection = false;
    expect(dispatcher.pollOnce()).toEqual([]);
    nowMs += 1_000;

    const projected = dispatcher.pollOnce();
    expect(projected).toHaveLength(1);
    expect(events.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run.end",
        event_id: "event-1",
      }),
    ]);
    expect(store.listOutboxForReplay({ sessionId: "s1" })).toEqual([
      expect.objectContaining({
        status: "delivered",
        attempts: 1,
        locked_at: null,
        last_error: null,
      }),
    ]);
    expect(dispatcher.getMetrics()).toMatchObject({
      delivered: 1,
      retried: 1,
      failed: 0,
    });
    store.close();
  });

  it("marks outbox rows failed after retry attempts are exhausted", () => {
    let nowMs = Date.parse("2026-06-07T00:00:00.000Z");
    const now = () => new Date(nowMs);
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
      availableAt: now().toISOString(),
      payload: {
        final_message_id: "msg-1",
        metadata: { run_id: "run-1" },
      },
    });
    const dispatcher = new OutboxDispatcher(
      store,
      events,
      {
        toClientEvent() {
          throw new Error("projection still unavailable");
        },
      } as ClientEventProjector,
      {
        maxAttempts: 2,
        retryBaseDelayMs: 1_000,
        retryMaxDelayMs: 1_000,
        now,
      },
    );

    dispatcher.pollOnce();
    nowMs += 1_000;
    dispatcher.pollOnce();

    expect(store.listOutboxForReplay({ sessionId: "s1" })).toEqual([
      expect.objectContaining({
        status: "failed",
        attempts: 2,
        locked_at: null,
        last_error: "projection still unavailable",
      }),
    ]);
    expect(store.fetchPendingOutbox(10)).toEqual([]);
    expect(dispatcher.getMetrics()).toMatchObject({
      delivered: 0,
      retried: 1,
      failed: 1,
      lastError: "projection still unavailable",
    });
    store.close();
  });

  it("reclaims stale locked outbox rows", () => {
    let nowMs = Date.parse("2026-06-07T00:00:00.000Z");
    const now = () => new Date(nowMs);
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
      availableAt: now().toISOString(),
      payload: {
        final_message_id: "msg-1",
        metadata: { run_id: "run-1" },
      },
    });
    expect(store.claimPendingOutbox({ limit: 1, lockTimeoutMs: 1_000, now: now() })).toEqual([
      expect.objectContaining({
        status: "pending",
        locked_at: "2026-06-07T00:00:00.000Z",
      }),
    ]);

    const dispatcher = new OutboxDispatcher(
      store,
      events,
      new ClientEventProjector(),
      {
        lockTimeoutMs: 1_000,
        now,
      },
    );

    nowMs += 999;
    expect(dispatcher.pollOnce()).toEqual([]);
    nowMs += 2;

    expect(dispatcher.pollOnce()).toHaveLength(1);
    expect(store.listOutboxForReplay({ sessionId: "s1" })).toEqual([
      expect.objectContaining({
        status: "delivered",
        locked_at: null,
      }),
    ]);
    expect(events.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run.end",
        event_id: "event-1",
      }),
    ]);
    store.close();
  });

  it("projects generic client event outbox rows with durable event metadata", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    const projector = new ClientEventProjector();
    store.createSession("s1");
    const row = store.appendOutbox({
      sessionId: "s1",
      runId: "run-1",
      eventId: "event-client-1",
      eventType: "client.context.usage",
      aggregateType: "run",
      aggregateId: "run-1",
      payload: {
        client_event: {
          type: "context.usage",
          session_id: "wrong-session",
          run_id: "wrong-run",
          event_id: "stale-event",
          event_seq: 99,
          stream_seq: 42,
          agent_name: "orchestrator_agent",
          data: { used_tokens: 10 },
          content: { used_tokens: 10 },
        },
      },
    });

    expect(projector.toClientEvent(row)).toMatchObject({
      type: "context.usage",
      session_id: "s1",
      run_id: "run-1",
      event_id: "event-client-1",
      event_seq: 1,
      agent_name: "orchestrator_agent",
      data: { used_tokens: 10 },
    });
    expect(projector.toClientEvent(row).stream_seq).toBeUndefined();
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
