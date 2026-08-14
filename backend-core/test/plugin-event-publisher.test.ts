import { describe, expect, it, vi } from "vitest";

import type { Envelope } from "../src/contracts/events.js";
import type { OutboxRow } from "../src/contracts/conversation-store/index.js";
import type {
  ClientEventPublishOptions,
  ClientEventPublisherPort,
} from "../src/contracts/runtime/core-runtime-ports.js";
import { createPluginClientEventPublisher } from "../src/plugins/plugin-event-publisher.js";
import { DurableClientEventPublisher } from "../src/services/runtime/event-outbox/client-event-publisher.js";

type PluginEventPayload = {
  plugin_id: string;
  event: string;
  data?: unknown;
  delivery?: string;
};

function fakePort(overrides: Partial<ClientEventPublisherPort> = {}) {
  const publish = vi.fn(async (_sessionId: string, _event: Envelope, _options?: ClientEventPublishOptions) => ({} as OutboxRow));
  const publishEphemeral = vi.fn(async (_sessionId: string, _event: Envelope) => {});
  return {
    publish,
    publishEphemeral,
    port: {
      publish,
      record: vi.fn(),
      prepare: vi.fn(),
      flush: vi.fn(),
      deliver: vi.fn(),
      publishEphemeral,
      ...overrides,
    } as unknown as ClientEventPublisherPort,
  };
}

describe("createPluginClientEventPublisher", () => {
  it("按插件盖章并以 durable 默认落 outbox（run 聚合）", async () => {
    const { port, publish, publishEphemeral } = fakePort();
    const publisher = createPluginClientEventPublisher("image-tools", port);

    await publisher.publish("session-1", "vision.progress", { percent: 40 }, { runId: "run-1", callId: "call-1" });

    expect(publishEphemeral).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    const [sessionId, envelope, options] = publish.mock.calls[0]!;
    expect(sessionId).toBe("session-1");
    expect(envelope).toMatchObject({
      type: "plugin_event",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "call-1",
    });
    const payload = envelope.payload as PluginEventPayload;
    expect(payload.plugin_id).toBe("image-tools");
    expect(payload.event).toBe("vision.progress");
    expect(payload.data).toEqual({ percent: 40 });
    expect(payload.delivery).toBe("durable");
    expect(options).toMatchObject({ runId: "run-1", aggregateType: "run", aggregateId: "run-1" });
  });

  it("会话级事件按 session 聚合且不带 run/call 字段", async () => {
    const { port, publish } = fakePort();
    const publisher = createPluginClientEventPublisher("audit", port);

    await publisher.publish("session-1", "config.notice");

    const [, envelope, options] = publish.mock.calls[0]!;
    expect(envelope).not.toHaveProperty("run_id");
    expect(envelope).not.toHaveProperty("call_id");
    expect((envelope.payload as PluginEventPayload).data).toBeUndefined();
    expect(options).toMatchObject({ runId: null, aggregateType: "session", aggregateId: "session-1" });
  });

  it("ephemeral 走实时直发通道、不落 outbox", async () => {
    const { port, publish, publishEphemeral } = fakePort();
    const publisher = createPluginClientEventPublisher("image-tools", port);

    await publisher.publish("session-1", "vision.progress", { percent: 10 }, { delivery: "ephemeral" });

    expect(publish).not.toHaveBeenCalled();
    expect(publishEphemeral).toHaveBeenCalledTimes(1);
    const [sessionId, envelope] = publishEphemeral.mock.calls[0]!;
    expect(sessionId).toBe("session-1");
    expect(envelope.type).toBe("plugin_event");
    expect((envelope.payload as PluginEventPayload).delivery).toBe("ephemeral");
  });

  it("端口无 publishEphemeral 时 ephemeral 降级 durable（不丢帧）", async () => {
    const { port, publish } = fakePort({ publishEphemeral: undefined });
    const publisher = createPluginClientEventPublisher("image-tools", port);

    await publisher.publish("session-1", "vision.progress", undefined, { delivery: "ephemeral" });

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("拒绝空会话、空事件名与非法负载", async () => {
    const { port, publish } = fakePort();
    const publisher = createPluginClientEventPublisher("image-tools", port);

    await expect(publisher.publish(" ", "x")).rejects.toThrow("session id");
    await expect(publisher.publish("session-1", "  ")).rejects.toThrow("must not be empty");
    await expect(publisher.publish("session-1", "x".repeat(200))).rejects.toThrow("exceeds");
    await expect(publisher.publish("session-1", "big", { blob: "x".repeat(128 * 1024) })).rejects.toThrow("exceeds");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(publisher.publish("session-1", "loop", circular)).rejects.toThrow("JSON-serializable");
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("DurableClientEventPublisher.publishEphemeral", () => {
  const envelope: Envelope = {
    type: "plugin_event",
    session_id: "session-1",
    payload: { plugin_id: "image-tools", event: "vision.progress", delivery: "ephemeral" },
  };

  it("有实时通道时直接扇出、不写存储", async () => {
    const recordEnvelope = vi.fn();
    const dispatchEphemeral = vi.fn(async () => {});
    const publisher = new DurableClientEventPublisher(
      { operations: { recordEnvelope } } as never,
      { dispatchRows: vi.fn(async () => []), dispatchEphemeral },
    );

    await publisher.publishEphemeral("session-1", envelope);

    expect(dispatchEphemeral).toHaveBeenCalledWith("session-1", envelope);
    expect(recordEnvelope).not.toHaveBeenCalled();
  });

  it("无实时通道时降级 durable publish（落 outbox）", async () => {
    const row = { id: 1, status: "pending" } as OutboxRow;
    const recordEnvelope = vi.fn(async () => ({ step: null, outbox: row }));
    const dispatchRows = vi.fn(async () => []);
    const publisher = new DurableClientEventPublisher(
      { operations: { recordEnvelope } } as never,
      { dispatchRows },
    );

    await publisher.publishEphemeral("session-1", envelope);

    expect(recordEnvelope).toHaveBeenCalledTimes(1);
    expect(dispatchRows).toHaveBeenCalledTimes(1);
  });
});
