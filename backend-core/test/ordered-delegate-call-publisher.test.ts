import { describe, expect, it, vi } from "vitest";

import { OrderedDelegateCallPublisher } from "../src/services/agent/sdk/runtime-adapter.js";

const delegate = {
  toolCallId: "call-1",
  toolName: "ocean_map_load_layers",
  arguments: { artifact_ids: ["viz-1"] },
};

describe("OrderedDelegateCallPublisher", () => {
  it("returns an early delegate so the tool_call journal item can commit it in place", () => {
    const publish = vi.fn();
    const subject = new OrderedDelegateCallPublisher(publish);

    subject.emit(delegate);
    expect(publish).not.toHaveBeenCalled();

    expect(subject.markToolCallPublished(delegate.toolCallId)).toEqual(delegate);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes immediately when tool_call was already published", () => {
    const publish = vi.fn();
    const subject = new OrderedDelegateCallPublisher(publish);

    subject.markToolCallPublished(delegate.toolCallId);
    subject.emit(delegate);
    subject.emit(delegate);

    expect(publish).toHaveBeenCalledOnce();
  });
});
