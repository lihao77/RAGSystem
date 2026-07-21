import type { Envelope } from "../../src/contracts/events.js";
import type { RealtimeEventBus } from "../../src/contracts/runtime/realtime-event-bus.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";

export function getRealtimeHistory(events: RealtimeEventBus, sessionId: string): Envelope[] {
  if (!(events instanceof RealtimeEventHub)) {
    throw new Error("test requires RealtimeEventHub history inspection");
  }
  return events.getHistory(sessionId);
}
