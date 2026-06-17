import type { ClientEvent } from "../../../contracts/events.js";
import type { ConversationStore } from "../../stores/conversation-store/index.js";
import type { OutboxRow } from "../../stores/conversation-store/types.js";
import type { RealtimeEventHub } from "../realtime-event-hub.js";
import { ClientEventProjector } from "./projector.js";

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

  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly realtimeEvents: RealtimeEventHub,
    private readonly projector = new ClientEventProjector(),
    options: OutboxDispatcherOptions = {},
  ) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
    this.retryBaseDelayMs = Math.max(0, Math.floor(options.retryBaseDelayMs ?? 1_000));
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, Math.floor(options.retryMaxDelayMs ?? 30_000));
    this.lockTimeoutMs = Math.max(0, Math.floor(options.lockTimeoutMs ?? 60_000));
    this.now = options.now ?? (() => new Date());
  }

  start(intervalMs = 500): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.pollOnce();
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

  pollOnce(limit = 100): ClientEvent[] {
    const rows = this.conversationStore.claimPendingOutbox({
      limit,
      lockTimeoutMs: this.lockTimeoutMs,
      now: this.now(),
    });
    return this.dispatchRows(rows);
  }

  dispatchRows(rows: OutboxRow[]): ClientEvent[] {
    const projected: ClientEvent[] = [];

    for (const row of [...rows].sort((left, right) => left.id - right.id)) {
      try {
        const event = this.projector.toClientEvent(row);
        projected.push(event);
        this.metrics.projected += 1;
        this.realtimeEvents.publish(row.session_id, event);
        this.conversationStore.markOutboxDelivered(row.id);
        this.metrics.delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nextAttempt = row.attempts + 1;
        if (nextAttempt >= this.maxAttempts) {
          this.conversationStore.markOutboxFailed(row.id, message);
          this.metrics.failed += 1;
        } else {
          this.conversationStore.markOutboxRetrying(row.id, message, this.nextAvailableAt(nextAttempt));
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
