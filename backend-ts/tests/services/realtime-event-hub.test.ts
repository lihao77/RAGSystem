import { describe, expect, it } from "vitest";

import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import type { Envelope } from "../../src/contracts/events.js";

describe("RealtimeEventHub idempotency", () => {
  it("drops duplicate events with the same message_id (fanout + history)", () => {
    const hub = new RealtimeEventHub();
    const received: Envelope[] = [];
    hub.subscribe("s1", (event) => received.push(event));

    const event: Envelope = {
      type: "stream_output",
      session_id: "s1",
      message_id: "evt-1",
      seq: 1,
      payload: { phase: "delta", content: "x" },
    };
    hub.publish("s1", event);
    hub.publish("s1", event); // 模拟 dispatcher publish 成功后未 markDelivered 而重投

    expect(received).toHaveLength(1);
    expect(hub.getHistory("s1")).toHaveLength(1);
  });

  it("still delivers distinct message_ids and events without an id", () => {
    const hub = new RealtimeEventHub();
    const received: Envelope[] = [];
    hub.subscribe("s1", (event) => received.push(event));

    hub.publish("s1", { type: "stream_output", session_id: "s1", message_id: "evt-1", payload: { phase: "delta" } });
    hub.publish("s1", { type: "stream_output", session_id: "s1", message_id: "evt-2", payload: { phase: "delta" } });
    hub.publish("s1", { type: "heartbeat", session_id: "s1" }); // 无 message_id：不参与去重，照常投递
    hub.publish("s1", { type: "heartbeat", session_id: "s1" });

    expect(received).toHaveLength(4);
  });

  it("re-allows a message_id once it is evicted from bounded history", () => {
    const hub = new RealtimeEventHub(2);
    const received: Envelope[] = [];
    hub.subscribe("s1", (event) => received.push(event));

    hub.publish("s1", { type: "stream_output", session_id: "s1", message_id: "a", payload: { phase: "delta" } });
    hub.publish("s1", { type: "stream_output", session_id: "s1", message_id: "b", payload: { phase: "delta" } });
    hub.publish("s1", { type: "stream_output", session_id: "s1", message_id: "c", payload: { phase: "delta" } }); // 淘汰 a
    expect(hub.getHistory("s1").map((event) => event.message_id)).toEqual(["b", "c"]);

    hub.publish("s1", { type: "stream_output", session_id: "s1", message_id: "a", payload: { phase: "delta" } }); // a 已淘汰，可再次投递
    expect(received).toHaveLength(4);
  });
});
