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

function streamEnvelope(phase: string, content = ""): Envelope {
  return {
    type: "stream_output",
    session_id: "thread-1",
    run_id: "internal-1",
    payload: { phase, content },
  };
}

describe("AguiTranslator text streaming", () => {
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
});
