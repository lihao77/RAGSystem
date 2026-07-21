import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { OutboxRow } from "../../../src/contracts/conversation-store/index.js";
import { POSTGRES_OUTBOX_MIGRATIONS } from "../../../src/adapters/saas/postgres/outbox-schema.js";
import { PostgresRealtimeEventRelay } from "../../../src/adapters/saas/postgres/realtime-event-relay.js";
import type { PostgresMemoryExecutor, PostgresQueryResult } from "../../../src/adapters/saas/postgres/memory-repository.js";

class ListenerClient extends EventEmitter {
  query = vi.fn(async () => ({ rows: [] }));
  release = vi.fn();
}

class RelayExecutor implements PostgresMemoryExecutor {
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(_sql: string): Promise<PostgresQueryResult<Row>> {
    return { rows: [{ id: 0 }] as unknown as Row[] };
  }
  transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> { return fn(this); }
}

const outboxRow: OutboxRow = {
  id: 7, event_id: "event-7", session_id: "session-1", tenant_id: "tenant-a", run_id: "run-1",
  session_seq: 3, event_type: "client.stream_output", aggregate_type: "run", aggregate_id: "run-1",
  payload: JSON.stringify({ client_event: { type: "stream_output", session_id: "session-1", run_id: "run-1", message_id: "event-7", payload: { text: "hello" } } }),
  status: "delivered", attempts: 0, available_at: null, locked_at: null,
  delivered_at: "2026-01-01T00:00:00.000Z", last_error: null, created_at: "2026-01-01T00:00:00.000Z",
};

describe("PostgreSQL realtime event relay", () => {
  it("notifies all processes only after an outbox row is delivered", () => {
    const sql = POSTGRES_OUTBOX_MIGRATIONS[1]?.sql ?? "";
    expect(sql).toContain("NEW.status = 'delivered'");
    expect(sql).toContain("pg_notify");
    expect(sql).toContain("event_outbox_realtime_notify");
  });

  it("fans a delivered notification out to the matching tenant bus", async () => {
    const client = new ListenerClient();
    const pool = { connect: vi.fn(async () => client) };
    const outbox = { getOutboxRow: vi.fn(async (tenantId: string, id: number) => tenantId === "tenant-a" && id === 7 ? outboxRow : null) };
    const relay = new PostgresRealtimeEventRelay(pool as never, new RelayExecutor(), outbox as never);
    await relay.start();
    const tenantA = relay.createBus("tenant-a");
    const tenantB = relay.createBus("tenant-b");
    const receivedA = vi.fn();
    const receivedB = vi.fn();
    tenantA.subscribe("session-1", receivedA);
    tenantB.subscribe("session-1", receivedB);

    client.emit("notification", { channel: "ragsystem_realtime_events", payload: JSON.stringify({ id: 7, tenant_id: "tenant-a" }) });
    await vi.waitFor(() => expect(receivedA).toHaveBeenCalledTimes(1));
    expect(receivedB).not.toHaveBeenCalled();

    // The local dispatcher and PostgreSQL notification can race on the same process.
    tenantA.publish("session-1", { type: "stream_output", session_id: "session-1", run_id: "run-1", message_id: "event-7", payload: { text: "hello" } });
    expect(receivedA).toHaveBeenCalledTimes(1);
    await relay.close();
  });

  it("installs one replacement listener after duplicate connection errors", async () => {
    const first = new ListenerClient();
    const second = new ListenerClient();
    first.on("error", () => undefined);
    const pool = { connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const relay = new PostgresRealtimeEventRelay(
      pool as never,
      new RelayExecutor(),
      { getOutboxRow: vi.fn(async () => null) } as never,
      { reconnectDelayMs: 0 },
    );
    await relay.start();

    first.emit("error", new Error("connection lost"));
    first.emit("error", new Error("duplicate error"));
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledTimes(2));
    expect(second.listenerCount("notification")).toBe(1);
    expect(second.listenerCount("error")).toBe(1);
    expect(first.release).toHaveBeenCalledTimes(1);

    await relay.close();
    expect(second.release).toHaveBeenCalledTimes(1);
  });
});
