import { describe, expect, it, vi } from "vitest";

import { AgentExecutionEventPublisher } from "../src/services/agent/execution/event-publisher.js";
import type { Envelope } from "../src/contracts/events.js";

const envelope = {
  type: "stream_output",
  session_id: "s-1",
  run_id: "r-1",
  payload: { phase: "delta", content: "x" },
} as unknown as Envelope;

describe("AgentExecutionEventPublisher ephemeral 通道", () => {
  it("端口有 publishEphemeral 时直发实时总线，不落 outbox", async () => {
    const clientEvents = {
      publishEphemeral: vi.fn(async () => undefined),
      publish: vi.fn(async () => {
        throw new Error("durable publish must not be used for ephemeral frames");
      }),
    };
    const publisher = new AgentExecutionEventPublisher(clientEvents as never);
    await publisher.publishEphemeralEnvelope(envelope);
    expect(clientEvents.publishEphemeral).toHaveBeenCalledWith("s-1", envelope);
    expect(clientEvents.publish).not.toHaveBeenCalled();
  });

  it("端口无 publishEphemeral 时降级 durable（不丢帧）", async () => {
    const clientEvents = { publish: vi.fn(async (..._args: unknown[]) => ({})) };
    const publisher = new AgentExecutionEventPublisher(clientEvents as never);
    await publisher.publishEphemeralEnvelope(envelope);
    expect(clientEvents.publish).toHaveBeenCalledOnce();
    expect(clientEvents.publish.mock.calls[0]?.[0]).toBe("s-1");
    expect(clientEvents.publish.mock.calls[0]?.[1]).toBe(envelope);
  });
});
