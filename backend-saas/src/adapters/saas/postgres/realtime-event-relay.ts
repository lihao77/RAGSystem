import type { Notification, Pool, PoolClient } from "pg";

import type { Envelope } from "@ragsystem/backend-core/contracts/events.js";
import type { RealtimeEventBus, RealtimeEventHandler } from "@ragsystem/backend-core/contracts/runtime/realtime-event-bus.js";
import { EnvelopeProjector } from "@ragsystem/backend-core/services/runtime/event-outbox/projector.js";
import { RealtimeEventHub } from "@ragsystem/backend-core/services/runtime/realtime-event-hub.js";
import type { PostgresExecutor } from "./postgres-executor.js";
import type { PostgresOutboxRepository } from "./outbox-repository.js";

const CHANNEL = "ragsystem_realtime_events";

export interface PostgresRealtimeEventRelayOptions { reconnectDelayMs?: number }

interface RealtimeNotificationPayload {
  id: number;
  tenantId: string;
  deliverySeq: number;
}

/** Shared PostgreSQL notification relay feeding each process's local websocket hub. */
export class PostgresRealtimeEventRelay {
  private readonly buses = new Map<string, Set<PostgresRealtimeEventBus>>();
  private readonly projector = new EnvelopeProjector();
  private client: PoolClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private catchUpRetryTimer: NodeJS.Timeout | null = null;
  private connecting: Promise<void> | null = null;
  private notificationChain = Promise.resolve();
  private closed = false;
  private lastDeliverySeq = 0;

  constructor(
    private readonly pool: Pool,
    private readonly executor: PostgresExecutor,
    private readonly outbox: PostgresOutboxRepository,
    private readonly options: PostgresRealtimeEventRelayOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.ensureConnected(false);
  }

  /**
   * Fan-out a projected outbox envelope to every in-process bus registered for the tenant.
   * Used by the shared process-level outbox dispatcher.
   */
  publishOutbox(row: { tenant_id: string; session_id: string }, event: Envelope): void {
    const buses = this.buses.get(row.tenant_id);
    if (!buses?.size) return;
    for (const bus of buses) bus.acceptRemote(row.session_id, event);
  }

  createBus(tenantId: string): PostgresRealtimeEventBus {
    const bus = new PostgresRealtimeEventBus(tenantId, this);
    const buses = this.buses.get(tenantId) ?? new Set<PostgresRealtimeEventBus>();
    buses.add(bus);
    this.buses.set(tenantId, buses);
    return bus;
  }

  unregister(bus: PostgresRealtimeEventBus): void {
    const buses = this.buses.get(bus.tenantId);
    buses?.delete(bus);
    if (buses?.size === 0) this.buses.delete(bus.tenantId);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.catchUpRetryTimer) clearTimeout(this.catchUpRetryTimer);
    this.reconnectTimer = null;
    this.catchUpRetryTimer = null;
    await this.connecting?.catch(() => undefined);
    await this.notificationChain.catch(() => undefined);
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeListener("notification", this.onNotification);
      client.removeListener("error", this.onError);
      await client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      client.release();
    }
    for (const buses of this.buses.values()) for (const bus of buses) bus.close();
    this.buses.clear();
  }

  private ensureConnected(recover: boolean): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.connect(recover).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(recover: boolean): Promise<void> {
    if (this.closed) return;
    const client = await this.pool.connect();
    if (this.closed) {
      client.release();
      return;
    }
    try {
      client.on("notification", this.onNotification);
      client.on("error", this.onError);
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      if (recover) {
        await this.enqueueDelivery(() => this.catchUp());
      } else {
        const watermark = await this.executor.query<{ watermark: unknown }>(
          `SELECT COALESCE(MAX(delivery_seq), 0) AS watermark
           FROM event_outbox
           WHERE status='delivered' AND delivery_seq IS NOT NULL`,
        );
        this.lastDeliverySeq = normalizeDeliverySeq(watermark.rows[0]?.watermark) ?? 0;
      }
    } catch (error) {
      if (this.client === client) this.client = null;
      client.removeListener("notification", this.onNotification);
      client.removeListener("error", this.onError);
      client.release(true);
      throw error;
    }
  }

  private readonly onNotification = (notification: Notification): void => {
    if (notification.channel !== CHANNEL || !notification.payload) return;
    const payload = parseNotificationPayload(notification.payload);
    if (!payload) {
      this.queueCatchUp();
      return;
    }
    void this.enqueueDelivery(() => this.deliverNotification(payload));
  };

  private readonly onError = (): void => {
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeListener("notification", this.onNotification);
      client.removeListener("error", this.onError);
      client.release(true);
    }
    this.scheduleReconnect();
  };

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected(true).catch(() => this.scheduleReconnect());
    }, Math.max(0, this.options.reconnectDelayMs ?? 1_000));
    this.reconnectTimer.unref?.();
  }

  private queueCatchUp(): void {
    if (this.closed) return;
    void this.enqueueDelivery(() => this.catchUp());
  }

  private enqueueDelivery(operation: () => Promise<void>): Promise<void> {
    const pending = this.notificationChain.then(operation);
    this.notificationChain = pending.catch(() => this.scheduleCatchUpRetry());
    return pending;
  }

  private scheduleCatchUpRetry(): void {
    if (this.closed || this.catchUpRetryTimer) return;
    this.catchUpRetryTimer = setTimeout(() => {
      this.catchUpRetryTimer = null;
      this.queueCatchUp();
    }, Math.max(0, this.options.reconnectDelayMs ?? 1_000));
    this.catchUpRetryTimer.unref?.();
  }

  private async deliverNotification(notification: RealtimeNotificationPayload): Promise<void> {
    if (notification.deliverySeq <= this.lastDeliverySeq) return;
    await this.catchUp(notification.deliverySeq - 1);
    if (notification.deliverySeq <= this.lastDeliverySeq) return;
    await this.deliver(notification.id, notification.tenantId);
    this.lastDeliverySeq = notification.deliverySeq;
  }

  private async catchUp(throughDeliverySeq?: number): Promise<void> {
    if (throughDeliverySeq !== undefined && throughDeliverySeq <= this.lastDeliverySeq) return;
    for (;;) {
      const params: unknown[] = [this.lastDeliverySeq];
      const upperBound = throughDeliverySeq === undefined
        ? ""
        : ` AND delivery_seq <= $${params.push(throughDeliverySeq)}`;
      const result = await this.executor.query<{
        id: number | string;
        tenant_id: string;
        delivery_seq: unknown;
      }>(
        `SELECT id,tenant_id,delivery_seq FROM event_outbox
         WHERE status='delivered' AND delivery_seq IS NOT NULL
           AND delivery_seq > $1${upperBound}
         ORDER BY delivery_seq LIMIT 500`,
        params,
      );
      for (const row of result.rows) {
        const deliverySeq = normalizeDeliverySeq(row.delivery_seq);
        if (deliverySeq === null) throw new Error(`invalid outbox delivery sequence: ${String(row.delivery_seq)}`);
        await this.deliver(Number(row.id), String(row.tenant_id));
        this.lastDeliverySeq = deliverySeq;
      }
      if (result.rows.length < 500) return;
    }
  }

  private async deliver(id: number, tenantId: string): Promise<void> {
    const buses = this.buses.get(tenantId);
    if (!buses?.size) return;
    const row = await this.outbox.getOutboxRow(tenantId, id);
    if (!row || row.status !== "delivered") {
      throw new Error(`delivered outbox row is unavailable: ${tenantId}:${id}`);
    }
    const event = this.projector.toEnvelope(row);
    for (const bus of buses) bus.acceptRemote(row.session_id, event);
  }
}

function parseNotificationPayload(payload: string): RealtimeNotificationPayload | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const id = Number(parsed.id);
    const tenantId = typeof parsed.tenant_id === "string" ? parsed.tenant_id.trim() : "";
    const deliverySeq = normalizeDeliverySeq(parsed.delivery_seq);
    if (!Number.isSafeInteger(id) || id <= 0 || !tenantId || deliverySeq === null) return null;
    return { id, tenantId, deliverySeq };
  } catch {
    return null;
  }
}

function normalizeDeliverySeq(value: unknown): number | null {
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

export class PostgresRealtimeEventBus implements RealtimeEventBus {
  private readonly local = new RealtimeEventHub();
  private closed = false;

  constructor(readonly tenantId: string, private readonly relay: PostgresRealtimeEventRelay) {}

  publish(sessionId: string, event: Envelope): void { this.local.publish(sessionId, event); }
  subscribe(sessionId: string, handler: RealtimeEventHandler): () => void { return this.local.subscribe(sessionId, handler); }
  getHistory(sessionId: string): Envelope[] { return this.local.getHistory(sessionId); }
  acceptRemote(sessionId: string, event: Envelope): void { this.local.publish(sessionId, event); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.unregister(this);
  }
}
