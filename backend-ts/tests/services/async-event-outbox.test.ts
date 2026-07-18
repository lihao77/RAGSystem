import { describe, expect, it } from "vitest";

import type { AsyncOutboxStore, OutboxRow } from "../../src/contracts/conversation-store/index.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { AsyncOutboxDispatcher } from "../../src/services/runtime/event-outbox/async-dispatcher.js";

const row = (id: number, attempts = 0): OutboxRow => ({
  id, event_id: `event-${id}`, session_id: "session-1", tenant_id: "tenant-1", run_id: "run-1", session_seq: id,
  event_type: "client.state_sync", aggregate_type: "run", aggregate_id: "run-1",
  payload: JSON.stringify({ client_event: { type: "state_sync", payload: { id } } }),
  status: "pending", attempts, available_at: null, locked_at: new Date().toISOString(), delivered_at: null,
  last_error: null, created_at: new Date().toISOString(),
});

describe("AsyncOutboxDispatcher", () => {
  it("projects and marks PostgreSQL rows delivered", async () => {
    const delivered: number[] = [];
    const store: AsyncOutboxStore = {
      appendOutbox: async () => row(1), claimPendingOutbox: async () => [row(1)],
      markOutboxDelivered: async (id) => { delivered.push(id); return true; },
      markOutboxRetrying: async () => false, markOutboxFailed: async () => false,
    };
    const hub = new RealtimeEventHub();
    const dispatcher = new AsyncOutboxDispatcher(store, hub);
    const events = await dispatcher.pollOnce();
    expect(events[0]).toMatchObject({ type: "state_sync", message_id: "event-1", seq: 1 });
    expect(delivered).toEqual([1]);
    expect(dispatcher.getMetrics()).toMatchObject({ projected: 1, delivered: 1 });
  });

  it("marks malformed payloads retrying until max attempts", async () => {
    const retrying: string[] = [];
    const store: AsyncOutboxStore = {
      appendOutbox: async () => row(1), claimPendingOutbox: async () => [{ ...row(1), payload: "not-json" }],
      markOutboxDelivered: async () => false,
      markOutboxRetrying: async (_id, error) => { retrying.push(error); return true; },
      markOutboxFailed: async () => false,
    };
    const dispatcher = new AsyncOutboxDispatcher(store, new RealtimeEventHub(), undefined, { maxAttempts: 3 });
    await dispatcher.pollOnce();
    expect(retrying[0]).toContain("Invalid outbox payload");
    expect(dispatcher.getMetrics().retried).toBe(1);
  });
});
