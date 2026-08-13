import { describe, expect, it, vi } from "vitest";

import type { Envelope } from "../src/contracts/events.js";
import type { OutboxRow } from "../src/contracts/conversation-store/index.js";
import { DurableClientEventPublisher } from "../src/services/runtime/event-outbox/client-event-publisher.js";

function outboxRow(id: number, sessionId = "session-1"): OutboxRow {
  return {
    id,
    event_id: `event-${id}`,
    session_id: sessionId,
    tenant_id: "tenant-1",
    run_id: "run-1",
    session_seq: id,
    event_type: "client.state_sync",
    aggregate_type: "run",
    aggregate_id: "run-1",
    payload: JSON.stringify({ client_event: { type: "state_sync", session_id: sessionId, payload: {} } }),
    status: "pending",
    attempts: 0,
    available_at: null,
    locked_at: null,
    delivered_at: null,
    last_error: null,
    created_at: "2026-08-13T00:00:00.000Z",
  };
}

describe("DurableClientEventPublisher", () => {
  it("serializes an already-committed delivery before later events in the same session", async () => {
    let releaseFirstDelivery!: () => void;
    const firstDeliveryGate = new Promise<void>((resolve) => { releaseFirstDelivery = resolve; });
    const order: string[] = [];
    const first = outboxRow(1);
    const second = outboxRow(2);
    const recordEnvelope = vi.fn(async () => {
      order.push("record:2");
      return { step: null, outbox: second };
    });
    const dispatchPendingRows = vi.fn(async (rows: OutboxRow[]) => {
      const id = rows[0]?.id;
      order.push(`dispatch:${id}:start`);
      if (id === 1) await firstDeliveryGate;
      order.push(`dispatch:${id}:end`);
      return [];
    });
    const publisher = new DurableClientEventPublisher(
      { operations: { recordEnvelope } } as never,
      { dispatchRows: dispatchPendingRows, dispatchPendingRows },
    );

    const firstDelivery = publisher.deliver([first]);
    await vi.waitFor(() => expect(dispatchPendingRows).toHaveBeenCalledTimes(1));
    const nextEvent: Envelope = {
      type: "state_sync",
      session_id: "session-1",
      run_id: "run-1",
      payload: { category: "session_updated" },
    };
    const nextPublish = publisher.publish("session-1", nextEvent, { eventId: "event-2" });

    await Promise.resolve();
    expect(recordEnvelope).not.toHaveBeenCalled();

    releaseFirstDelivery();
    await Promise.all([firstDelivery, nextPublish]);

    expect(order).toEqual([
      "dispatch:1:start",
      "dispatch:1:end",
      "record:2",
      "dispatch:2:start",
      "dispatch:2:end",
    ]);
  });

  it("does not carry a best-effort delivery failure into a later flush", async () => {
    const dispatchPendingRows = vi.fn(async () => {
      throw new Error("realtime unavailable");
    });
    const publisher = new DurableClientEventPublisher(
      { operations: { recordEnvelope: vi.fn() } } as never,
      { dispatchRows: dispatchPendingRows, dispatchPendingRows },
    );

    await expect(publisher.deliver([outboxRow(1)])).rejects.toThrow("realtime unavailable");
    await expect(publisher.flush("session-1")).resolves.toBeUndefined();
  });
});
