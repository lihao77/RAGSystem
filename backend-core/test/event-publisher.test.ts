import { describe, expect, it, vi } from "vitest";

import { AgentExecutionEventPublisher } from "../src/services/agent/execution/event-publisher.js";
import type { Envelope } from "../src/contracts/events.js";
import type { AgentConfig } from "../src/contracts/agent/agent-config.js";

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

describe("contextMarkers 参与者身份投影（预留口径）", () => {
  // 生产中 contextMarkers 只服务 root run（buildRootAgentStart）；子 run 锚点帧的
  // 盖章在 delegation/events.ts buildAgentCallStart。此处钉住投影口径本身：任何
  // 后续经 contextMarkers 发布的 child 生命周期帧都必须自动带顶层 participant_id。
  const agent = { agent_name: "worker", display_name: "Worker" } as unknown as AgentConfig;
  const clientEvents = { publish: vi.fn(async (..._args: unknown[]) => ({})) };
  const publisher = new AgentExecutionEventPublisher(clientEvents as never);

  it("child run 的 agent_started 顶层盖 participant_id", () => {
    const envelope = publisher.buildRootAgentStart({
      sessionId: "s-1",
      runId: "child-run-1",
      taskId: "t-1",
      requestId: "req-1",
      rootCallId: "child-call",
      parentCallId: "root-call",
      agent,
      threadKey: "child:child-1",
      childAgentId: "child-1",
      task: "inspect",
    });
    expect(envelope.participant_id).toBe("child-1");
    expect(envelope.payload).toMatchObject({ lineage: { parent_call_id: "root-call" } });
  });

  it("root run 的 agent_started 不带 participant_id", () => {
    const envelope = publisher.buildRootAgentStart({
      sessionId: "s-1",
      runId: "run-1",
      taskId: "t-1",
      requestId: "req-1",
      rootCallId: "run-1",
      agent,
      threadKey: "root",
      task: "main",
    });
    expect(envelope.participant_id).toBeUndefined();
  });
});
