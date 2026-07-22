import { describe, expect, it } from "vitest";

import type { AsyncOutboxStore, OutboxRow } from "../../src/contracts/conversation-store/index.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";

const row = (id: number, attempts = 0): OutboxRow => ({
  id, event_id: `event-${id}`, session_id: "session-1", tenant_id: "tenant-1", run_id: "run-1", session_seq: id,
  event_type: "client.state_sync", aggregate_type: "run", aggregate_id: "run-1",
  payload: JSON.stringify({ client_event: { type: "state_sync", payload: { id } } }),
  status: "pending", attempts, available_at: null, locked_at: new Date().toISOString(), delivered_at: null,
  last_error: null, created_at: new Date().toISOString(),
});

describe("OutboxDispatcher async port", () => {
  it("projects and marks PostgreSQL rows delivered", async () => {
    const delivered: number[] = [];
    const store = createOutboxStore({
      appendOutbox: async () => row(1), claimPendingOutbox: async () => [row(1)],
      markOutboxDelivered: async (id, _tenantId) => { delivered.push(id); return true; },
      markOutboxRetrying: async () => false, markOutboxFailed: async () => false,
    });
    const hub = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, hub);
    const events = await dispatcher.pollOnce();
    expect(events[0]).toMatchObject({ type: "state_sync", message_id: "event-1", seq: 1 });
    expect(delivered).toEqual([1]);
    expect(dispatcher.getMetrics()).toMatchObject({ projected: 1, delivered: 1 });
  });

  it("marks malformed payloads retrying until max attempts", async () => {
    const retrying: string[] = [];
    const store = createOutboxStore({
      appendOutbox: async () => row(1), claimPendingOutbox: async () => [{ ...row(1), payload: "not-json" }],
      markOutboxDelivered: async () => false,
      markOutboxRetrying: async (_id, error) => { retrying.push(error); return true; },
      markOutboxFailed: async () => false,
    });
    const dispatcher = new OutboxDispatcher(store, new RealtimeEventHub(), undefined, { maxAttempts: 3 });
    await dispatcher.pollOnce();
    expect(retrying[0]).toContain("Invalid outbox payload");
    expect(dispatcher.getMetrics().retried).toBe(1);
  });

  it("publishes a new row only after acquiring delivery ownership", async () => {
    let claimed = false;
    const store = {
      claimOutboxRows: async () => {
        if (claimed) return [];
        claimed = true;
        return [row(1)];
      },
      claimPendingOutbox: async () => [],
      markOutboxDelivered: async () => true,
      markOutboxRetrying: async () => false,
      markOutboxFailed: async () => false,
    } as unknown as AsyncOutboxStore;
    const hub = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, hub, undefined, { tenantId: "tenant-1" });

    await Promise.all([dispatcher.dispatchPendingRows([row(1)]), dispatcher.dispatchPendingRows([row(1)])]);

    expect(hub.getHistory("session-1")).toHaveLength(1);
  });

  it("does not redispatch non-pending rows when targeted claiming is unavailable", async () => {
    const store = {
      claimPendingOutbox: async () => [],
      markOutboxDelivered: async () => true,
      markOutboxRetrying: async () => false,
      markOutboxFailed: async () => false,
    };
    const hub = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(store, hub);

    await dispatcher.dispatchPendingRows([
      row(1),
      { ...row(2), status: "delivered", delivered_at: new Date().toISOString() },
    ]);

    expect(hub.getHistory("session-1")).toEqual([
      expect.objectContaining({ message_id: "event-1" }),
    ]);
  });
});

function createOutboxStore(overrides: Partial<AsyncOutboxStore>): AsyncOutboxStore {
  return {
    appendOutbox: async () => row(1),
    claimPendingOutbox: async () => [],
    claimOutboxRows: async () => [],
    listOutboxForReplay: async () => [],
    markOutboxDelivered: async () => false,
    markOutboxRetrying: async () => false,
    markOutboxFailed: async () => false,
    getOutboxRow: async () => null,
    listOutbox: async () => ({ items: [], total: 0, limit: 100, offset: 0, has_more: false }),
    retryOutbox: async () => false,
    retryOutboxBatch: async () => ({ ids: [], matched: 0, retried: 0 }),
    deleteDeliveredOutbox: async () => 0,
    ...overrides,
  };
}
