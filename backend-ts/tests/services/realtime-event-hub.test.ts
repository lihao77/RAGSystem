import { describe, expect, it } from "vitest";

import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import type { ClientEvent } from "../../src/contracts/events.js";

describe("RealtimeEventHub idempotency", () => {
  it("drops duplicate events with the same event_id (fanout + history)", () => {
    const hub = new RealtimeEventHub();
    const received: ClientEvent[] = [];
    hub.subscribe("s1", (event) => received.push(event));

    const event: ClientEvent = { type: "output.chunk", event_id: "evt-1", event_seq: 1, data: { content: "x" } };
    hub.publish("s1", event);
    hub.publish("s1", event); // 模拟 dispatcher publish 成功后未 markDelivered 而重投

    expect(received).toHaveLength(1);
    expect(hub.getHistory("s1")).toHaveLength(1);
  });

  it("still delivers distinct event_ids and events without an id", () => {
    const hub = new RealtimeEventHub();
    const received: ClientEvent[] = [];
    hub.subscribe("s1", (event) => received.push(event));

    hub.publish("s1", { type: "output.chunk", event_id: "evt-1", data: {} });
    hub.publish("s1", { type: "output.chunk", event_id: "evt-2", data: {} });
    hub.publish("s1", { type: "heartbeat" }); // 无 event_id：不参与去重，照常投递
    hub.publish("s1", { type: "heartbeat" });

    expect(received).toHaveLength(4);
  });

  it("re-allows an event_id once it is evicted from bounded history", () => {
    const hub = new RealtimeEventHub(2);
    const received: ClientEvent[] = [];
    hub.subscribe("s1", (event) => received.push(event));

    hub.publish("s1", { type: "output.chunk", event_id: "a", data: {} });
    hub.publish("s1", { type: "output.chunk", event_id: "b", data: {} });
    hub.publish("s1", { type: "output.chunk", event_id: "c", data: {} }); // 淘汰 a
    expect(hub.getHistory("s1").map((event) => event.event_id)).toEqual(["b", "c"]);

    hub.publish("s1", { type: "output.chunk", event_id: "a", data: {} }); // a 已淘汰，可再次投递
    expect(received).toHaveLength(4);
  });
});
