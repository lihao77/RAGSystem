import type { Envelope } from "../../contracts/events.js";
import type { RealtimeEventBus, RealtimeEventHandler } from "../../contracts/realtime-event-bus.js";
export type { RealtimeEventHandler } from "../../contracts/realtime-event-bus.js";

interface SessionStream {
  events: Envelope[];
  /** 已投递事件的 message_id 集合（与 events 同步淘汰），用于幂等去重。 */
  deliveredIds: Set<string>;
}

export class RealtimeEventHub implements RealtimeEventBus {
  private readonly subscribers = new Map<string, Set<RealtimeEventHandler>>();
  private readonly streams = new Map<string, SessionStream>();
  private readonly maxHistory: number;

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
  }

  /**
   * 向会话订阅者投递事件并入历史。幂等：带 message_id 的事件若已投递过则直接跳过——
   * outbox dispatcher 是唯一发布方，每个事件都携带唯一 message_id；当 dispatcher 在 publish
   * 成功后、markOutboxDelivered 前崩溃/失败而重投时，这里据 message_id 去重，避免向 live
   * 订阅者重复 fanout、避免历史重复（影响断线重连回放）。
   */
  publish(sessionId: string, event: Envelope): void {
    const stream = this.streams.get(sessionId) ?? { events: [], deliveredIds: new Set<string>() };
    const messageId = typeof event.message_id === "string" ? event.message_id : null;
    if (messageId !== null && stream.deliveredIds.has(messageId)) {
      return;
    }

    const normalized = {
      ...event,
      session_id: event.session_id ?? sessionId,
      timestamp: event.timestamp ?? Date.now(),
    };

    stream.events.push(normalized);
    if (messageId !== null) {
      stream.deliveredIds.add(messageId);
    }
    if (stream.events.length > this.maxHistory) {
      const evicted = stream.events.splice(0, stream.events.length - this.maxHistory);
      for (const old of evicted) {
        if (typeof old.message_id === "string") {
          stream.deliveredIds.delete(old.message_id);
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

  getHistory(sessionId: string): Envelope[] {
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
