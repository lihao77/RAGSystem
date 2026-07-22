import { describe, expect, it, vi } from "vitest";

import type { OutboxRow, RunStepRecord } from "../../src/contracts/conversation-store/index.js";
import type {
  RuntimeRecordEnvelopeInput,
  RuntimeStorage,
} from "../../src/contracts/storage/runtime-storage.js";
import { createTenantId } from "../../src/identity/types.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";

const NOW = "2026-01-01T00:00:00.000Z";

function createHarness(beforeRecord?: (input: RuntimeRecordEnvelopeInput) => Promise<void>) {
  const inputs: RuntimeRecordEnvelopeInput[] = [];
  const dispatched: OutboxRow[][] = [];
  let committed = false;
  const recordEnvelope = vi.fn(async (input: RuntimeRecordEnvelopeInput) => {
    await beforeRecord?.(input);
    inputs.push(input);
    const step: RunStepRecord | null = input.step ? {
      id: 10,
      run_id: input.step.runId,
      event_id: input.step.eventId ?? null,
      step_order: 1,
      step_type: input.step.stepType,
    } : null;
    const outbox: OutboxRow = {
      id: 20,
      event_id: input.outbox.eventId,
      session_id: input.outbox.sessionId,
      tenant_id: "tenant-1",
      run_id: input.outbox.runId ?? null,
      session_seq: 1,
      event_type: input.outbox.eventType,
      aggregate_type: input.outbox.aggregateType,
      aggregate_id: input.outbox.aggregateId,
      payload: JSON.stringify(input.outbox.payload),
      status: "pending",
      attempts: 0,
      available_at: null,
      locked_at: null,
      delivered_at: null,
      last_error: null,
      created_at: NOW,
    };
    committed = true;
    return { step, outbox };
  });
  const storage = {
    tenantId: createTenantId("tnt_async_publisher"),
    operations: {
      startRun: vi.fn(),
      recordEnvelope,
      finalizeRun: vi.fn(),
    },
  } as unknown as RuntimeStorage;
  const dispatcher = {
    dispatchRows: vi.fn(async (rows: OutboxRow[]) => {
      expect(committed).toBe(true);
      dispatched.push(rows);
      return [];
    }),
  };
  return { publisher: new DurableClientEventPublisher(storage, dispatcher), inputs, dispatched, recordEnvelope, dispatcher };
}

describe("DurableClientEventPublisher async port", () => {
  it("atomically records a step and outbox before dispatching", async () => {
    const harness = createHarness();

    const row = await harness.publisher.publish("session-1", {
      type: "tool_call",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "call-1",
      payload: { tool: "read_file", phase: "start" },
    }, { eventId: "stable-event-1" });

    expect(harness.inputs).toEqual([{
      step: expect.objectContaining({
        sessionId: "session-1",
        runId: "run-1",
        eventId: "stable-event-1",
        stepType: "protocol.envelope.v1",
      }),
      outbox: expect.objectContaining({
        eventId: "stable-event-1",
        sessionId: "session-1",
        runId: "run-1",
        eventType: "client.tool_call",
      }),
    }]);
    expect(row.event_id).toBe("stable-event-1");
    expect(harness.dispatched).toEqual([[expect.objectContaining({ event_id: "stable-event-1" })]]);
  });

  it("records without dispatch and resolves one stable id per call", async () => {
    const harness = createHarness();

    const row = await harness.publisher.record("session-1", {
      type: "stream_output",
      session_id: "session-1",
      run_id: "run-1",
      payload: { phase: "delta", content: "a" },
    });

    const input = harness.inputs[0]!;
    expect(input.outbox.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.step?.eventId).toBe(input.outbox.eventId);
    expect(row.event_id).toBe(input.outbox.eventId);
    expect(harness.dispatcher.dispatchRows).not.toHaveBeenCalled();
  });

  it("keeps an explicit retry id stable across repeated publisher calls", async () => {
    const harness = createHarness();
    const event = {
      type: "tool_result" as const,
      session_id: "session-1",
      run_id: "run-1",
      call_id: "call-1",
      payload: { tool: "read_file", phase: "end", ok: true },
    };

    await harness.publisher.record("session-1", event, { eventId: "retry-event" });
    await harness.publisher.record("session-1", event, { eventId: "retry-event" });

    expect(harness.inputs.map((input) => [input.step?.eventId, input.outbox.eventId])).toEqual([
      ["retry-event", "retry-event"],
      ["retry-event", "retry-event"],
    ]);
  });

  it("does not dispatch when the atomic record fails", async () => {
    const harness = createHarness();
    harness.recordEnvelope.mockRejectedValueOnce(new Error("transaction failed"));

    await expect(harness.publisher.publish("session-1", {
      type: "tool_call",
      session_id: "session-1",
      run_id: "run-1",
      payload: { tool: "read_file", phase: "start" },
    }, { eventId: "failed-event" })).rejects.toThrow("transaction failed");

    expect(harness.dispatcher.dispatchRows).not.toHaveBeenCalled();
    await expect(harness.publisher.flush("session-1")).rejects.toThrow("transaction failed");
  });

  it("flushes all queued writes for a session in publication order", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const harness = createHarness(async (input) => {
      if (input.outbox.eventId === "event-1") await firstBlocked;
    });

    const first = harness.publisher.publish("session-1", {
      type: "stream_output",
      session_id: "session-1",
      run_id: "run-1",
      payload: { phase: "delta", content: "first" },
    }, { eventId: "event-1" });
    const second = harness.publisher.publish("session-1", {
      type: "stream_output",
      session_id: "session-1",
      run_id: "run-1",
      payload: { phase: "delta", content: "second" },
    }, { eventId: "event-2" });
    let flushed = false;
    const flush = harness.publisher.flush("session-1").then(() => { flushed = true; });

    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(harness.recordEnvelope).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second, flush]);

    expect(harness.inputs.map((input) => input.outbox.eventId)).toEqual(["event-1", "event-2"]);
    expect(harness.recordEnvelope.mock.calls.map(([input]) => input.outbox.eventId)).toEqual([
      "event-1",
      "event-2",
    ]);
  });
});
