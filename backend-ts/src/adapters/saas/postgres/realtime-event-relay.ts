import type { Notification, Pool, PoolClient } from "pg";

import type { Envelope } from "../../../contracts/events.js";
import type { RealtimeEventBus, RealtimeEventHandler } from "../../../contracts/runtime/realtime-event-bus.js";
import { EnvelopeProjector } from "../../../services/runtime/event-outbox/projector.js";
import { RealtimeEventHub } from "../../../services/runtime/realtime-event-hub.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";
import type { PostgresOutboxRepository } from "./outbox-repository.js";

const CHANNEL = "ragsystem_realtime_events";

export interface PostgresRealtimeEventRelayOptions { reconnectDelayMs?: number }

/** Shared PostgreSQL notification relay feeding each process's local websocket hub. */
export class PostgresRealtimeEventRelay {
  private readonly buses = new Map<string, Set<PostgresRealtimeEventBus>>();
  private readonly projector = new EnvelopeProjector();
  private client: PoolClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private lastSeenOutboxId = 0;

  constructor(
    private readonly pool: Pool,
    private readonly executor: PostgresMemoryExecutor,
    private readonly outbox: PostgresOutboxRepository,
    private readonly options: PostgresRealtimeEventRelayOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.ensureConnected(false);
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
    this.reconnectTimer = null;
    await this.connecting?.catch(() => undefined);
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
        const watermark = await this.executor.query<{ id: number | string }>("SELECT COALESCE(MAX(id),0) AS id FROM event_outbox");
        this.lastSeenOutboxId = Number(watermark.rows[0]?.id ?? 0);
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
    void this.deliverPayload(notification.payload).catch(() => undefined);
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

  private async catchUp(): Promise<void> {
    for (;;) {
      const result = await this.executor.query<{ id: number | string; tenant_id: string }>(
        "SELECT id,tenant_id FROM event_outbox WHERE status='delivered' AND id>$1 ORDER BY id LIMIT 500",
        [this.lastSeenOutboxId],
      );
      for (const row of result.rows) await this.deliver(Number(row.id), String(row.tenant_id));
      if (result.rows.length < 500) return;
    }
  }

  private async deliverPayload(payload: string): Promise<void> {
    const parsed = JSON.parse(payload) as { id?: unknown; tenant_id?: unknown };
    const id = Number(parsed.id);
    const tenantId = typeof parsed.tenant_id === "string" ? parsed.tenant_id : "";
    if (!Number.isSafeInteger(id) || id <= 0 || !tenantId) return;
    await this.deliver(id, tenantId);
  }

  private async deliver(id: number, tenantId: string): Promise<void> {
    this.lastSeenOutboxId = Math.max(this.lastSeenOutboxId, id);
    const buses = this.buses.get(tenantId);
    if (!buses?.size) return;
    const row = await this.outbox.getOutboxRow(tenantId, id);
    if (!row || row.status !== "delivered") return;
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
