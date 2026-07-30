import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PostgresRealtimeEventRelay } from "../dist/adapters/saas/postgres/realtime-event-relay.js";

const CHANNEL = "ragsystem_realtime_events";
const EPOCH = "1970-01-01T00:00:00.000Z";

class FakePoolClient extends EventEmitter {
  released = false;

  async query() {
    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

function createPool(client) {
  return { connect: async () => client };
}

function outboxRow({ id, tenantId = "tenant-1", sessionId = "session-1", deliveredAt }) {
  return {
    id,
    event_id: `event-${id}`,
    session_id: sessionId,
    tenant_id: tenantId,
    run_id: null,
    session_seq: id,
    event_type: "client.state_sync",
    aggregate_type: "session",
    aggregate_id: sessionId,
    payload: JSON.stringify({
      client_event: {
        type: "state_sync",
        session_id: sessionId,
        payload: { category: "session_updated" },
      },
    }),
    status: "delivered",
    attempts: 0,
    available_at: null,
    locked_at: null,
    delivered_at: deliveredAt,
    last_error: null,
    created_at: deliveredAt,
  };
}

function notify(client) {
  client.emit("notification", { channel: CHANNEL, payload: "outbox" });
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("realtime notifications serialize catch-up queries", async () => {
  const client = new FakePoolClient();
  let catchUpCalls = 0;
  let activeQueries = 0;
  let maxActiveQueries = 0;
  let releaseFirst;
  const firstQueryGate = new Promise((resolve) => { releaseFirst = resolve; });
  const executor = {
    async query(sql) {
      if (sql.includes("ORDER BY delivered_at DESC")) return { rows: [] };
      catchUpCalls += 1;
      activeQueries += 1;
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
      if (catchUpCalls === 1) await firstQueryGate;
      activeQueries -= 1;
      return { rows: [] };
    },
  };
  const relay = new PostgresRealtimeEventRelay(
    createPool(client),
    executor,
    { getOutboxRow: async () => null },
    { reconnectDelayMs: 0 },
  );

  await relay.start();
  notify(client);
  notify(client);
  await waitFor(() => catchUpCalls === 1, "first catch-up did not start");
  assert.equal(maxActiveQueries, 1);
  releaseFirst();
  await waitFor(() => catchUpCalls === 2, "second catch-up did not run");
  assert.equal(maxActiveQueries, 1);
  await relay.close();
});

test("failed delivery keeps the cursor and retries the same row", async () => {
  const client = new FakePoolClient();
  const deliveredAt = "2026-07-30T01:00:00.000Z";
  const catchUpParams = [];
  const executor = {
    async query(sql, params) {
      if (sql.includes("ORDER BY delivered_at DESC")) return { rows: [] };
      catchUpParams.push(params);
      return catchUpParams.length <= 2
        ? { rows: [{ id: 7, tenant_id: "tenant-1", delivered_at: deliveredAt }] }
        : { rows: [] };
    },
  };
  let reads = 0;
  const row = outboxRow({ id: 7, deliveredAt });
  const relay = new PostgresRealtimeEventRelay(
    createPool(client),
    executor,
    {
      async getOutboxRow() {
        reads += 1;
        return reads === 1 ? null : row;
      },
    },
    { reconnectDelayMs: 0 },
  );
  const bus = relay.createBus("tenant-1");
  const received = [];
  bus.subscribe("session-1", (event) => received.push(event));

  await relay.start();
  notify(client);
  await waitFor(() => received.length === 1, "failed row was not retried");

  assert.equal(reads, 2);
  assert.deepEqual(catchUpParams[0], [EPOCH, 0]);
  assert.deepEqual(catchUpParams[1], [EPOCH, 0]);
  assert.equal(received[0].message_id, "event-7");
  await relay.close();
});

test("catch-up orders by delivered_at before id", async () => {
  const client = new FakePoolClient();
  const watermarkAt = "2026-07-30T01:00:00.000Z";
  const laterAt = "2026-07-30T01:00:01.000Z";
  const catchUpParams = [];
  let catchUpCalls = 0;
  const executor = {
    async query(sql, params) {
      if (sql.includes("ORDER BY delivered_at DESC")) {
        return { rows: [{ id: 100, delivered_at: watermarkAt }] };
      }
      catchUpCalls += 1;
      catchUpParams.push(params);
      return catchUpCalls === 1
        ? { rows: [{ id: 5, tenant_id: "tenant-1", delivered_at: laterAt }] }
        : { rows: [] };
    },
  };
  const relay = new PostgresRealtimeEventRelay(
    createPool(client),
    executor,
    { getOutboxRow: async () => outboxRow({ id: 5, deliveredAt: laterAt }) },
  );
  const bus = relay.createBus("tenant-1");
  const received = [];
  bus.subscribe("session-1", (event) => received.push(event));

  await relay.start();
  notify(client);
  await waitFor(() => received.length === 1, "later timestamp with smaller id was skipped");

  assert.deepEqual(catchUpParams[0], [watermarkAt, 100]);
  assert.equal(received[0].seq, 5);
  await relay.close();
});
