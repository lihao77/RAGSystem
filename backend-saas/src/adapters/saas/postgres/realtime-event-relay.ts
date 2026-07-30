import type { Notification, Pool, PoolClient } from "pg";

import type { Envelope } from "@ragsystem/backend-core/contracts/events.js";
import type { RealtimeEventBus, RealtimeEventHandler } from "@ragsystem/backend-core/contracts/runtime/realtime-event-bus.js";
import { EnvelopeProjector } from "@ragsystem/backend-core/services/runtime/event-outbox/projector.js";
import { RealtimeEventHub } from "@ragsystem/backend-core/services/runtime/realtime-event-hub.js";
import type { PostgresExecutor } from "./postgres-executor.js";
import type { PostgresOutboxRepository } from "./outbox-repository.js";

const CHANNEL = "ragsystem_realtime_events";

export interface PostgresRealtimeEventRelayOptions { reconnectDelayMs?: number }

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
  private lastDeliveredAt = "1970-01-01T00:00:00.000Z";
  private lastDeliveredOutboxId = 0;

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
        await this.catchUp();
      } else {
        const watermark = await this.executor.query<{ id: number | string; delivered_at: unknown }>(
          `SELECT id,delivered_at FROM event_outbox
           WHERE status='delivered' AND delivered_at IS NOT NULL
           ORDER BY delivered_at DESC,id DESC LIMIT 1`,
        );
        const row = watermark.rows[0];
        if (row) {
          this.lastDeliveredAt = new Date(String(row.delivered_at)).toISOString();
          this.lastDeliveredOutboxId = Number(row.id);
        }
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
    this.queueCatchUp();
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
    this.notificationChain = this.notificationChain
      .then(() => this.catchUp())
      .catch(() => this.scheduleCatchUpRetry());
  }

  private scheduleCatchUpRetry(): void {
    if (this.closed || this.catchUpRetryTimer) return;
    this.catchUpRetryTimer = setTimeout(() => {
      this.catchUpRetryTimer = null;
      this.queueCatchUp();
    }, Math.max(0, this.options.reconnectDelayMs ?? 1_000));
    this.catchUpRetryTimer.unref?.();
  }

  private async catchUp(): Promise<void> {
    for (;;) {
      const result = await this.executor.query<{
        id: number | string;
        tenant_id: string;
        delivered_at: unknown;
      }>(
        `SELECT id,tenant_id,delivered_at FROM event_outbox
         WHERE status='delivered' AND delivered_at IS NOT NULL
           AND (delivered_at>$1::timestamptz OR (delivered_at=$1::timestamptz AND id>$2))
         ORDER BY delivered_at,id LIMIT 500`,
        [this.lastDeliveredAt, this.lastDeliveredOutboxId],
      );
      for (const row of result.rows) {
        await this.deliver(Number(row.id), String(row.tenant_id));
        this.lastDeliveredAt = new Date(String(row.delivered_at)).toISOString();
        this.lastDeliveredOutboxId = Number(row.id);
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
