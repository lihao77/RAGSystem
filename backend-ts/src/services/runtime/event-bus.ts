import type { ClientEvent } from "../../contracts/events.js";

export type EventHandler = (event: ClientEvent) => void;

export class InMemoryEventBus {
  private readonly subscribers = new Map<string, Set<EventHandler>>();
  private readonly history = new Map<string, ClientEvent[]>();
  private readonly maxHistory: number;

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
  }

  publish(sessionId: string, event: ClientEvent): void {
    const normalized = {
      ...event,
      session_id: event.session_id ?? sessionId,
      timestamp: event.timestamp ?? Date.now(),
    };

    const events = this.history.get(sessionId) ?? [];
    events.push(normalized);
    if (events.length > this.maxHistory) {
      events.splice(0, events.length - this.maxHistory);
    }
    this.history.set(sessionId, events);

    for (const handler of this.subscribers.get(sessionId) ?? []) {
      try {
        handler(normalized);
      } catch {
        // Realtime fanout is best-effort; durable replay remains the recovery path.
      }
    }
  }

  getHistory(sessionId: string): ClientEvent[] {
    return [...(this.history.get(sessionId) ?? [])];
  }

  subscribe(sessionId: string, handler: EventHandler): () => void {
    const handlers = this.subscribers.get(sessionId) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.subscribers.set(sessionId, handlers);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.subscribers.delete(sessionId);
      }
    };
  }
}
