import type { ClientEvent } from "../../../contracts/events.js";
import type { ConversationStore } from "../../stores/conversation-store.js";
import type { OutboxRow } from "../../stores/conversation-store/types.js";
import type { InMemoryEventBus } from "../event-bus.js";
import { ClientEventProjector } from "./projector.js";

export type OutboxDispatcherMode = "shadow" | "live";

export interface OutboxDispatcherMetrics {
  projected: number;
  delivered: number;
  failed: number;
  lastError: string | null;
}

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly metrics: OutboxDispatcherMetrics = {
    projected: 0,
    delivered: 0,
    failed: 0,
    lastError: null,
  };

  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly events: InMemoryEventBus,
    private readonly projector = new ClientEventProjector(),
    private readonly mode: OutboxDispatcherMode = "shadow",
  ) {}

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
    const rows = this.conversationStore.fetchPendingOutbox(limit);
    return this.dispatchRows(rows);
  }

  dispatchRows(rows: OutboxRow[]): ClientEvent[] {
    const projected: ClientEvent[] = [];

    for (const row of [...rows].sort((left, right) => left.id - right.id)) {
      try {
        const event = this.projector.toClientEvent(row);
        projected.push(event);
        this.metrics.projected += 1;
        if (this.mode === "live") {
          this.events.publish(row.session_id, event);
        }
        this.conversationStore.markOutboxDelivered(row.id);
        this.metrics.delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.conversationStore.markOutboxFailed(row.id, message);
        this.metrics.failed += 1;
        this.metrics.lastError = message;
      }
    }

    return projected;
  }

  getMetrics(): OutboxDispatcherMetrics {
    return { ...this.metrics };
  }
}
