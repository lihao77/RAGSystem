import type { Envelope } from "../events.js";

export type RealtimeEventHandler = (event: Envelope) => void;

/** Live event fanout port. Durable replay remains owned by the outbox repository. */
export interface RealtimeEventBus {
  publish(sessionId: string, event: Envelope): void;
  subscribe(sessionId: string, handler: RealtimeEventHandler): () => void;
}
