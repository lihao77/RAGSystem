import type { Envelope } from "../../../contracts/events.js";
import type { AsyncOutboxStore, OutboxRow } from "../../../contracts/conversation-store/index.js";
import type { RealtimeEventBus } from "../../../contracts/runtime/realtime-event-bus.js";
import { EnvelopeProjector } from "./projector.js";

export interface OutboxDispatcherMetrics {
  projected: number;
  delivered: number;
  retried: number;
  failed: number;
  lastError: string | null;
}

export interface OutboxDispatcherOptions {
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  lockTimeoutMs?: number;
  now?: () => Date;
  tenantId?: string;
  publishFromOutbox?: (row: OutboxRow, event: Envelope) => void;
}

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;
  private readonly metrics: OutboxDispatcherMetrics = {
    projected: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
    lastError: null,
  };
  private readonly tenantId: string | undefined;
  private readonly publishFromOutbox: ((row: OutboxRow, event: Envelope) => void) | undefined;

  constructor(
    private readonly outbox: AsyncOutboxStore,
    private readonly realtimeEvents: RealtimeEventBus | null,
    private readonly projector = new EnvelopeProjector(),
    options: OutboxDispatcherOptions = {},
  ) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
    this.retryBaseDelayMs = Math.max(0, Math.floor(options.retryBaseDelayMs ?? 1_000));
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, Math.floor(options.retryMaxDelayMs ?? 30_000));
    this.lockTimeoutMs = Math.max(0, Math.floor(options.lockTimeoutMs ?? 60_000));
    this.now = options.now ?? (() => new Date());
    this.tenantId = options.tenantId?.trim() || undefined;
    this.publishFromOutbox = options.publishFromOutbox;
  }

  start(intervalMs = 500): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(limit = 100): Promise<Envelope[]> {
    const rows = await this.outbox.claimPendingOutbox({
      ...(this.tenantId ? { tenantId: this.tenantId } : {}),
      limit,
      lockTimeoutMs: this.lockTimeoutMs,
      now: this.now(),
    });
    return this.dispatchRows(rows);
  }

  async dispatchPendingRows(rows: OutboxRow[]): Promise<Envelope[]> {
    const scoped = this.tenantId
      ? rows.filter((row) => row.tenant_id === this.tenantId)
      : rows;
    const ids = scoped.filter((row) => row.status === "pending" || row.status === "retrying").map((row) => row.id);
    if (ids.length === 0) return [];
    const claimed = await this.outbox.claimOutboxRows({
      ids,
      ...(this.tenantId ? { tenantId: this.tenantId } : {}),
      lockTimeoutMs: this.lockTimeoutMs,
      now: this.now(),
    });
    return this.dispatchRows(claimed);
  }

  async dispatchRows(rows: OutboxRow[]): Promise<Envelope[]> {
    const projected: Envelope[] = [];

    for (const row of [...rows].sort((left, right) => left.id - right.id)) {
      try {
        const event = this.projector.toEnvelope(row);
        projected.push(event);
        this.metrics.projected += 1;
        if (this.publishFromOutbox) {
          this.publishFromOutbox(row, event);
        } else if (this.realtimeEvents) {
          this.realtimeEvents.publish(row.session_id, event);
        } else {
          throw new Error("OutboxDispatcher requires realtimeEvents or publishFromOutbox");
        }
        if (await this.outbox.markOutboxDelivered(row.id, row.tenant_id)) this.metrics.delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nextAttempt = row.attempts + 1;
        if (nextAttempt >= this.maxAttempts) {
          await this.outbox.markOutboxFailed(row.id, message, row.tenant_id);
          this.metrics.failed += 1;
        } else {
          await this.outbox.markOutboxRetrying(row.id, message, this.nextAvailableAt(nextAttempt), row.tenant_id);
          this.metrics.retried += 1;
        }
        this.metrics.lastError = message;
      }
    }

    return projected;
  }

  getMetrics(): OutboxDispatcherMetrics {
    return { ...this.metrics };
  }

  private nextAvailableAt(attemptsAfterFailure: number): string {
    const exponent = Math.max(0, attemptsAfterFailure - 1);
    const exponentialDelayMs = this.retryBaseDelayMs === 0 ? 0 : this.retryBaseDelayMs * 2 ** exponent;
    const delayMs = Math.min(this.retryMaxDelayMs, exponentialDelayMs);
    return new Date(this.now().getTime() + delayMs).toISOString();
  }
}
