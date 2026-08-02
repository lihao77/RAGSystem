import { describe, expect, it } from "vitest";

import type { Envelope } from "../src/contracts/events.js";
import { AguiTranslator } from "../src/services/agui-gateway/agui-translator.js";

function translator() {
  return new AguiTranslator({
    threadId: "thread-1",
    externalRunId: "external-1",
    internalRunId: "internal-1",
    genInterruptId: () => "interrupt-1",
  });
}

function streamEnvelope(phase: string, content = "", seq?: number): Envelope {
  return {
    type: "stream_output",
    session_id: "thread-1",
    run_id: "internal-1",
    ...(seq !== undefined ? { seq } : {}),
    payload: { phase, content },
  };
}

function interactionEnvelope(callId = "approval-1"): Envelope {
  return {
    type: "interaction",
    session_id: "thread-1",
    run_id: "internal-1",
    call_id: callId,
    payload: {
      kind: "approval",
      phase: "required",
      tool: "dangerous_tool",
      prompt: "确认执行？",
    },
  };
}

describe("AguiTranslator text streaming", () => {
  it("preserves model request lifecycle through AG-UI CUSTOM events", () => {
    const result = translator().translate({
      type: "model_request",
      session_id: "thread-1",
      run_id: "internal-1",
      call_id: "root-call",
      agent_id: "agent",
      seq: 12,
      payload: { phase: "start", round: 1 },
    });

    expect(result.events).toEqual([expect.objectContaining({
      type: "CUSTOM",
      name: "model_request",
      eventSeq: 12,
      value: { phase: "start", round: 1 },
    })]);
  });

  it("does not append the persisted final answer after streamed deltas", () => {
    const subject = translator();
    subject.translate(streamEnvelope("first_token"));
    expect(subject.translate(streamEnvelope("delta", "变量列表")).events).toEqual([
      expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "变量列表" }),
    ]);
    expect(subject.translate(streamEnvelope("final", "变量列表")).events).toEqual([
      expect.objectContaining({ type: "TEXT_MESSAGE_END" }),
    ]);
  });

  it("uses final content when a provider emitted no text deltas", () => {
    const events = translator().translate(streamEnvelope("final", "完整回答")).events;
    expect(events.map((event) => event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
    expect(events[1]).toEqual(expect.objectContaining({ delta: "完整回答" }));
  });

  it("projects the durable outbox cursor on translated AG-UI events", () => {
    const events = translator().translate(streamEnvelope("delta", "继续", 27)).events;
    expect(events).toEqual([
      expect.objectContaining({ type: "TEXT_MESSAGE_START", eventSeq: 27 }),
      expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "继续", eventSeq: 27 }),
    ]);
  });
});

describe("AguiTranslator interrupt identity", () => {
  it("uses the durable interaction id for approval interrupts", () => {
    const result = translator().translate(interactionEnvelope("approval-42"));

    expect(result.interruptRecord?.aguiInterruptId).toBe("approval-42");
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "RUN_FINISHED",
      outcome: { type: "interrupt", interrupts: [expect.objectContaining({ id: "approval-42" })] },
    }));
  });

  it("keeps delegated tool metadata in the interrupt fallback", () => {
    const result = translator().translate({
      type: "delegate_call",
      session_id: "thread-1",
      run_id: "internal-1",
      call_id: "call-42",
      payload: { tool: "ocean_map_load_layers", input: { artifact_ids: ["art_a"] } },
    });

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "RUN_FINISHED",
      outcome: {
        type: "interrupt",
        interrupts: [expect.objectContaining({
          id: "call-42",
          metadata: { toolName: "ocean_map_load_layers", arguments: { artifact_ids: ["art_a"] } },
        })],
      },
    }));
  });
});
