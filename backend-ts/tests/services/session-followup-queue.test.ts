import { describe, expect, it } from "vitest";

import { SessionFollowupQueue } from "../../src/services/agent/execution/session-followup-queue.js";

function entry(activeRunId: string, requestId: string) {
  return {
    activeRunId,
    sessionId: "session-1",
    requestId,
    displayTask: requestId,
    modelTask: requestId,
    metadata: {},
    userId: null,
    agent: {} as never,
    provider: {} as never,
    modelName: "model",
    selectedLlm: null,
  };
}

describe("SessionFollowupQueue", () => {
  it("drains followups in FIFO order per active run", () => {
    const queue = new SessionFollowupQueue();
    queue.enqueue(entry("run-1", "first"));
    queue.enqueue(entry("run-2", "other"));
    queue.enqueue(entry("run-1", "second"));

    expect(queue.drain("run-1").map((item) => item.requestId)).toEqual(["first", "second"]);
    expect(queue.drain("run-1")).toEqual([]);
    expect(queue.drain("run-2").map((item) => item.requestId)).toEqual(["other"]);
  });
});
