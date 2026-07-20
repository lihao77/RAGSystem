import type { Envelope } from "../../../contracts/events.js";
import type { AsyncOutboxStore, OutboxRow } from "../../../contracts/conversation-store/index.js";
import type { RealtimeEventBus } from "../../../contracts/runtime/realtime-event-bus.js";
import { EnvelopeProjector } from "./projector.js";
import type { OutboxDispatcherMetrics, OutboxDispatcherOptions } from "./dispatcher.js";

export interface AsyncOutboxDispatcherOptions extends OutboxDispatcherOptions {
  tenantId?: string;
}

/** Async counterpart of the Local synchronous dispatcher for SaaS repositories. */
export class AsyncOutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;
  private readonly tenantId: string | undefined;
  private readonly metrics: OutboxDispatcherMetrics = { projected: 0, delivered: 0, retried: 0, failed: 0, lastError: null };

  constructor(
    private readonly outbox: AsyncOutboxStore,
    private readonly realtimeEvents: RealtimeEventBus,
    private readonly projector = new EnvelopeProjector(),
    options: AsyncOutboxDispatcherOptions = {},
  ) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
    this.retryBaseDelayMs = Math.max(0, Math.floor(options.retryBaseDelayMs ?? 1_000));
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, Math.floor(options.retryMaxDelayMs ?? 30_000));
    this.lockTimeoutMs = Math.max(0, Math.floor(options.lockTimeoutMs ?? 60_000));
    this.now = options.now ?? (() => new Date());
    this.tenantId = options.tenantId?.trim() || undefined;
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pollOnce().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
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

  /** Claim specific newly-written rows before publishing, racing safely with the recovery poller. */
  async dispatchPendingRows(rows: OutboxRow[]): Promise<Envelope[]> {
    const ids = rows.filter((row) => row.status === "pending" || row.status === "retrying").map((row) => row.id);
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
        this.realtimeEvents.publish(row.session_id, event);
        if (await this.outbox.markOutboxDelivered(row.id)) this.metrics.delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nextAttempt = row.attempts + 1;
        if (nextAttempt >= this.maxAttempts) {
          await this.outbox.markOutboxFailed(row.id, message);
          this.metrics.failed += 1;
        } else {
          await this.outbox.markOutboxRetrying(row.id, message, this.nextAvailableAt(nextAttempt));
          this.metrics.retried += 1;
        }
        this.metrics.lastError = message;
      }
    }
    return projected;
  }

  getMetrics(): OutboxDispatcherMetrics { return { ...this.metrics }; }

  private nextAvailableAt(attemptsAfterFailure: number): string {
    const exponent = Math.max(0, attemptsAfterFailure - 1);
    const exponentialDelayMs = this.retryBaseDelayMs === 0 ? 0 : this.retryBaseDelayMs * 2 ** exponent;
    return new Date(this.now().getTime() + Math.min(this.retryMaxDelayMs, exponentialDelayMs)).toISOString();
  }
}
