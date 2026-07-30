import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PostgresRealtimeEventRelay } from "../dist/adapters/saas/postgres/realtime-event-relay.js";

const CHANNEL = "ragsystem_realtime_events";

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

function createRotatingPool(clients) {
  let index = 0;
  return { connect: async () => clients[index++] };
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

function notify(client, { id, tenantId = "tenant-1", deliverySeq }) {
  client.emit("notification", {
    channel: CHANNEL,
    payload: JSON.stringify({ id, tenant_id: tenantId, delivery_seq: deliverySeq }),
  });
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("realtime notifications serialize direct outbox delivery", async () => {
  const client = new FakePoolClient();
  let activeReads = 0;
  let maxActiveReads = 0;
  let releaseFirstRead;
  const firstReadGate = new Promise((resolve) => { releaseFirstRead = resolve; });
  const executor = {
    async query(sql) {
      if (sql.includes("MAX(delivery_seq)")) return { rows: [{ watermark: 0 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const rows = new Map([
    [1, outboxRow({ id: 1, deliveredAt: "2026-07-30T01:00:00.000Z" })],
    [2, outboxRow({ id: 2, deliveredAt: "2026-07-30T01:00:01.000Z" })],
  ]);
  let reads = 0;
  const relay = new PostgresRealtimeEventRelay(
    createPool(client),
    executor,
    {
      async getOutboxRow(_tenantId, id) {
        reads += 1;
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        if (reads === 1) await firstReadGate;
        activeReads -= 1;
        return rows.get(id) ?? null;
      },
    },
    { reconnectDelayMs: 0 },
  );
  const bus = relay.createBus("tenant-1");
  const received = [];
  bus.subscribe("session-1", (event) => received.push(event));

  await relay.start();
  notify(client, { id: 1, deliverySeq: 1 });
  notify(client, { id: 2, deliverySeq: 2 });
  await waitFor(() => reads === 1, "first direct delivery did not start");
  assert.equal(maxActiveReads, 1);
  releaseFirstRead();
  await waitFor(() => received.length === 2, "second notification was not delivered");
  assert.equal(maxActiveReads, 1);
  await relay.close();
});

test("failed delivery keeps the cursor and retries the same row", async () => {
  const client = new FakePoolClient();
  const deliveredAt = "2026-07-30T01:00:00.000Z";
  const catchUpParams = [];
  const executor = {
    async query(sql, params) {
      if (sql.includes("MAX(delivery_seq)")) return { rows: [{ watermark: 0 }] };
      catchUpParams.push(params);
      return params.length === 1
        ? { rows: [{ id: 7, tenant_id: "tenant-1", delivery_seq: 7 }] }
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
  notify(client, { id: 7, deliverySeq: 7 });
  await waitFor(() => received.length === 1, "failed row was not retried");

  assert.equal(reads, 2);
  assert.deepEqual(catchUpParams[0], [0, 6]);
  assert.deepEqual(catchUpParams[1], [0]);
  assert.equal(received[0].message_id, "event-7");
  await relay.close();
});

test("notification delivers a late commit even when its outbox id and timestamp are older", async () => {
  const client = new FakePoolClient();
  const oldDeliveredAt = "2026-07-30T00:59:00.000Z";
  const executor = {
    async query(sql) {
      if (sql.includes("MAX(delivery_seq)")) return { rows: [{ watermark: 10 }] };
      throw new Error(`unexpected catch-up query: ${sql}`);
    },
  };
  const relay = new PostgresRealtimeEventRelay(
    createPool(client),
    executor,
    { getOutboxRow: async () => outboxRow({ id: 5, deliveredAt: oldDeliveredAt }) },
  );
  const bus = relay.createBus("tenant-1");
  const received = [];
  bus.subscribe("session-1", (event) => received.push(event));

  await relay.start();
  notify(client, { id: 5, deliverySeq: 11 });
  await waitFor(() => received.length === 1, "late commit with older id was skipped");

  assert.equal(received[0].seq, 5);
  await relay.close();
});

test("reconnect catches up rows committed while the listener was disconnected", async () => {
  const firstClient = new FakePoolClient();
  const secondClient = new FakePoolClient();
  let recoveryQueries = 0;
  const executor = {
    async query(sql, params) {
      if (sql.includes("MAX(delivery_seq)")) return { rows: [{ watermark: 3 }] };
      recoveryQueries += 1;
      assert.deepEqual(params, [3]);
      return { rows: [{ id: 2, tenant_id: "tenant-1", delivery_seq: 4 }] };
    },
  };
  const relay = new PostgresRealtimeEventRelay(
    createRotatingPool([firstClient, secondClient]),
    executor,
    { getOutboxRow: async () => outboxRow({ id: 2, deliveredAt: "2026-07-30T00:58:00.000Z" }) },
    { reconnectDelayMs: 0 },
  );
  const bus = relay.createBus("tenant-1");
  const received = [];
  bus.subscribe("session-1", (event) => received.push(event));

  await relay.start();
  firstClient.emit("error", new Error("connection lost"));
  await waitFor(() => received.length === 1, "disconnect catch-up did not deliver the missed row");

  assert.equal(recoveryQueries, 1);
  assert.equal(received[0].message_id, "event-2");
  assert.equal(firstClient.released, true);
  await relay.close();
});
