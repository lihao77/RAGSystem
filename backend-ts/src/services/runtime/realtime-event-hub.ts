import type { ClientEvent } from "../../contracts/events.js";

export type RealtimeEventHandler = (event: ClientEvent) => void;

interface SessionStream {
  events: ClientEvent[];
  /** 已投递事件的 event_id 集合（与 events 同步淘汰），用于幂等去重。 */
  deliveredIds: Set<string>;
}

export class RealtimeEventHub {
  private readonly subscribers = new Map<string, Set<RealtimeEventHandler>>();
  private readonly streams = new Map<string, SessionStream>();
  private readonly maxHistory: number;

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
  }

  /**
   * 向会话订阅者投递事件并入历史。幂等：带 event_id 的事件若已投递过则直接跳过——
   * outbox dispatcher 是唯一发布方，每个事件都携带唯一 event_id；当 dispatcher 在 publish
   * 成功后、markOutboxDelivered 前崩溃/失败而重投时，这里据 event_id 去重，避免向 live
   * 订阅者重复 fanout、避免历史重复（影响断线重连回放）。
   */
  publish(sessionId: string, event: ClientEvent): void {
    const stream = this.streams.get(sessionId) ?? { events: [], deliveredIds: new Set<string>() };
    const eventId = typeof event.event_id === "string" ? event.event_id : null;
    if (eventId !== null && stream.deliveredIds.has(eventId)) {
      return;
    }

    const normalized = {
      ...event,
      session_id: event.session_id ?? sessionId,
      timestamp: event.timestamp ?? Date.now(),
    };

    stream.events.push(normalized);
    if (eventId !== null) {
      stream.deliveredIds.add(eventId);
    }
    if (stream.events.length > this.maxHistory) {
      const evicted = stream.events.splice(0, stream.events.length - this.maxHistory);
      for (const old of evicted) {
        if (typeof old.event_id === "string") {
          stream.deliveredIds.delete(old.event_id);
        }
      }
    }
    this.streams.set(sessionId, stream);

    for (const handler of this.subscribers.get(sessionId) ?? []) {
      try {
        handler(normalized);
      } catch {
        // Realtime fanout is best-effort; durable replay remains the recovery path.
      }
    }
  }

  getHistory(sessionId: string): ClientEvent[] {
    return [...(this.streams.get(sessionId)?.events ?? [])];
  }

  subscribe(sessionId: string, handler: RealtimeEventHandler): () => void {
    const handlers = this.subscribers.get(sessionId) ?? new Set<RealtimeEventHandler>();
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
