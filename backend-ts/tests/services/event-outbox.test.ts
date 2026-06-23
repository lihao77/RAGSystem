import { describe, expect, it } from "vitest";

import type { Envelope } from "../../src/contracts/events.js";
import type { OutboxRow } from "../../src/contracts/conversation-store/types.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { EnvelopeProjector } from "../../src/services/runtime/event-outbox/projector.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";

describe("event outbox projection and dispatch", () => {
  it("restores client.* outbox rows to envelopes, stamping persisted event_id/seq", () => {
    const projector = new EnvelopeProjector();
    const rows = completedRows();

    const projected = rows.map((row) => projector.toEnvelope(row));

    // projector 是单分支还原：所有产出方写 client.{envelope_type} 行，还原后盖
    // message_id=row.event_id、seq=row.session_seq、session_id/run_id 以落库为准。
    expect(projected.map((event) => event.type)).toEqual([
      "tool_call",
      "stream_output",
      "agent_ended",
      "state_sync",
      "state_sync",
      "run_ended",
    ]);
    expect(projected[0]).toMatchObject({
      message_id: "event-1",
      seq: 1,
      session_id: "s1",
      run_id: "run-1",
      payload: { phase: "start", tool: "list_memory_index", mode: "projection" },
    });
    expect(projected[2]).toMatchObject({
      agent_id: "orchestrator_agent",
      call_id: "call-root",
      payload: {
        phase: "end",
        result: "answer",
        success: true,
      },
    });
    expect(projected[5]).toMatchObject({
      payload: {
        status: "completed",
      },
    });
    // 还原后不再保留产出方临时 message_id/seq（盖戳为权威持久化值）。
    expect(projected[0]?.message_id).toBe("event-1");
    expect(projected[0]?.seq).toBe(1);
  });

  it("restores failed terminal client.* outbox rows in protocol order", () => {
    const projector = new EnvelopeProjector();
    const rows = failedRows();

    const projected = rows.map((row) => projector.toEnvelope(row));

    expect(projected.map((event) => event.type)).toEqual([
      "agent_ended",
      "state_sync",
      "error",
      "run_ended",
    ]);
    expect(projected[2]).toMatchObject({
      agent_id: "orchestrator_agent",
      call_id: "call-root",
      payload: {
        code: "RuntimeError",
        message: "provider failed",
      },
    });
    expect(projected[3]).toMatchObject({
      payload: {
        status: "failed",
        reason: "provider failed",
      },
    });
  });

  it("publishes projected events to realtime fanout by default", () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    const realtimeEvents = new RealtimeEventHub();
    store.createSession("s1");
    appendClientRow(store, "s1", "run-1", "event-1", {
      type: "run_ended",
      session_id: "s1",
      run_id: "run-1",
      payload: { status: "completed" },
    });

    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    const projected = dispatcher.pollOnce();

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      type: "run_ended",
      message_id: "event-1",
      seq: 1,
    });
    expect(store.fetchPendingOutbox(10)).toEqual([]);
    expect(realtimeEvents.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run_ended",
        message_id: "event-1",
        seq: 1,
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
    const store = createConversationStore({ dbPath: ":memory:" });
    const realtimeEvents = new RealtimeEventHub();
    store.createSession("s1");
    appendClientRow(store, "s1", "run-1", "event-1", {
      type: "run_ended",
      session_id: "s1",
      run_id: "run-1",
      payload: { status: "completed" },
    });

    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
    dispatcher.pollOnce();

    expect(realtimeEvents.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run_ended",
        message_id: "event-1",
        seq: 1,
      }),
    ]);
    store.close();
  });

  it("does not retry delivered rows when a realtime subscriber fails", () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    const realtimeEvents = new RealtimeEventHub();
    store.createSession("s1");
    realtimeEvents.subscribe("s1", () => {
      throw new Error("websocket send failed");
    });
    appendClientRow(store, "s1", "run-1", "event-1", {
      type: "run_ended",
      session_id: "s1",
      run_id: "run-1",
      payload: { status: "completed" },
    });

    const dispatcher = new OutboxDispatcher(store, realtimeEvents);
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
    expect(realtimeEvents.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run_ended",
        message_id: "event-1",
      }),
    ]);
    store.close();
  });

  it("retries projection failures with backoff before delivering", () => {
    let nowMs = Date.parse("2026-06-07T00:00:00.000Z");
    const now = () => new Date(nowMs);
    const store = createConversationStore({ dbPath: ":memory:" });
    const realtimeEvents = new RealtimeEventHub();
    store.createSession("s1");
    appendClientRow(
      store,
      "s1",
      "run-1",
      "event-1",
      {
        type: "run_ended",
        session_id: "s1",
        run_id: "run-1",
        payload: { status: "completed" },
      },
      now().toISOString(),
    );

    let failProjection = true;
    const projector = new EnvelopeProjector();
    const dispatcher = new OutboxDispatcher(
      store,
      realtimeEvents,
      {
        toEnvelope(row: OutboxRow) {
          if (failProjection) {
            throw new Error("projection unavailable");
          }
          return projector.toEnvelope(row);
        },
      } as EnvelopeProjector,
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
    expect(realtimeEvents.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run_ended",
        message_id: "event-1",
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
    const store = createConversationStore({ dbPath: ":memory:" });
    const realtimeEvents = new RealtimeEventHub();
    store.createSession("s1");
    appendClientRow(
      store,
      "s1",
      "run-1",
      "event-1",
      {
        type: "run_ended",
        session_id: "s1",
        run_id: "run-1",
        payload: { status: "completed" },
      },
      now().toISOString(),
    );
    const dispatcher = new OutboxDispatcher(
      store,
      realtimeEvents,
      {
        toEnvelope() {
          throw new Error("projection still unavailable");
        },
      } as EnvelopeProjector,
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
    const store = createConversationStore({ dbPath: ":memory:" });
    const realtimeEvents = new RealtimeEventHub();
    store.createSession("s1");
    appendClientRow(
      store,
      "s1",
      "run-1",
      "event-1",
      {
        type: "run_ended",
        session_id: "s1",
        run_id: "run-1",
        payload: { status: "completed" },
      },
      now().toISOString(),
    );
    expect(store.claimPendingOutbox({ limit: 1, lockTimeoutMs: 1_000, now: now() })).toEqual([
      expect.objectContaining({
        status: "pending",
        locked_at: "2026-06-07T00:00:00.000Z",
      }),
    ]);

    const dispatcher = new OutboxDispatcher(
      store,
      realtimeEvents,
      new EnvelopeProjector(),
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
    expect(realtimeEvents.getHistory("s1")).toEqual([
      expect.objectContaining({
        type: "run_ended",
        message_id: "event-1",
      }),
    ]);
    store.close();
  });

  it("stamps persisted event_id/seq over transient client_event values", () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    const projector = new EnvelopeProjector();
    store.createSession("s1");
    const row = appendClientRow(store, "s1", "run-1", "event-client-1", {
      // 产出方临时值（session_id/run_id/message_id/seq）一律不可信——还原后以落库权威值盖戳。
      type: "state_sync",
      session_id: "wrong-session",
      run_id: "wrong-run",
      message_id: "stale-event",
      seq: 99,
      payload: { category: "context_usage", detail: { used_tokens: 10 } },
    });

    expect(projector.toEnvelope(row)).toMatchObject({
      type: "state_sync",
      session_id: "s1",
      run_id: "run-1",
      message_id: "event-client-1",
      seq: 1,
      payload: { category: "context_usage", detail: { used_tokens: 10 } },
    });
    // 还原后 message_id/seq 以落库权威值为准（盖戳覆盖产出方临时值）。
    const restored = projector.toEnvelope(row);
    expect(restored.message_id).toBe("event-client-1");
    expect(restored.seq).toBe(1);
    store.close();
  });
});

/**
 * recorder / 各产出方现在直接写 `client.{envelope_type}` 行，payload.client_event 存完整 Envelope。
 * 这里构造同构的 outbox 行，验证 projector 的单分支还原 + 盖戳。
 */
function appendClientRow(
  store: ReturnType<typeof createConversationStore>,
  sessionId: string,
  runId: string,
  eventId: string,
  clientEvent: Envelope,
  availableAt?: string,
): OutboxRow {
  return store.appendOutbox({
    sessionId,
    runId,
    eventId,
    eventType: `client.${clientEvent.type}`,
    aggregateType: "run",
    aggregateId: runId,
    availableAt,
    payload: { client_event: clientEvent },
  });
}

function completedRows(): OutboxRow[] {
  return [
    row(1, "client.tool_call", {
      type: "tool_call",
      session_id: "s1",
      run_id: "run-1",
      call_id: "call-tool-1",
      payload: { phase: "start", tool: "list_memory_index", mode: "projection" },
    }),
    row(2, "client.stream_output", {
      type: "stream_output",
      session_id: "s1",
      run_id: "run-1",
      payload: { phase: "final", content: "answer" },
    }),
    row(3, "client.agent_ended", {
      type: "agent_ended",
      session_id: "s1",
      run_id: "run-1",
      agent_id: "orchestrator_agent",
      call_id: "call-root",
      payload: { phase: "end", result: "answer", success: true },
    }),
    row(4, "client.state_sync", {
      type: "state_sync",
      session_id: "s1",
      run_id: "run-1",
      payload: { category: "compression", detail: { status: "success" } },
    }),
    row(5, "client.state_sync", {
      type: "state_sync",
      session_id: "s1",
      run_id: "run-1",
      payload: { category: "message_saved", ref: { message_id: "msg-1", seq: 2, role: "assistant" } },
    }),
    row(6, "client.run_ended", {
      type: "run_ended",
      session_id: "s1",
      run_id: "run-1",
      payload: { status: "completed" },
    }),
  ];
}

function failedRows(): OutboxRow[] {
  return [
    row(1, "client.agent_ended", {
      type: "agent_ended",
      session_id: "s1",
      run_id: "run-1",
      agent_id: "orchestrator_agent",
      call_id: "call-root",
      payload: { phase: "end", result: "provider failed", success: false },
    }),
    row(2, "client.state_sync", {
      type: "state_sync",
      session_id: "s1",
      run_id: "run-1",
      payload: { category: "compression", detail: { status: "error" } },
    }),
    row(3, "client.error", {
      type: "error",
      session_id: "s1",
      run_id: "run-1",
      agent_id: "orchestrator_agent",
      call_id: "call-root",
      payload: { code: "RuntimeError", message: "provider failed" },
    }),
    row(4, "client.run_ended", {
      type: "run_ended",
      session_id: "s1",
      run_id: "run-1",
      payload: { status: "failed", reason: "provider failed" },
    }),
  ];
}

function row(sessionSeq: number, eventType: string, clientEvent: Envelope): OutboxRow {
  return {
    id: sessionSeq,
    event_id: `event-${sessionSeq}`,
    session_id: "s1",
    run_id: "run-1",
    session_seq: sessionSeq,
    event_type: eventType,
    aggregate_type: "run",
    aggregate_id: "run-1",
    payload: JSON.stringify({ client_event: clientEvent }),
    status: "pending",
    attempts: 0,
    available_at: null,
    locked_at: null,
    delivered_at: null,
    last_error: null,
    created_at: "2026-06-07T00:00:00.000Z",
  };
}
