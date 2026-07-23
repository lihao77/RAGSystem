import { describe, expect, it, vi } from "vitest";

import type { ExecutionStorage } from "../../src/contracts/execution/execution-storage.js";
import type { AgentExecutionEventPublisher } from "../../src/services/agent/execution/event-publisher.js";
import { SessionFollowupQueue } from "../../src/services/agent/execution/session-followup-queue.js";
import { persistQueuedFollowupsAtRound } from "../../src/services/agent/sdk/runtime-adapter.js";

describe("persistQueuedFollowupsAtRound", () => {
  it("writes a followup at the next round boundary, then publishes message_saved", async () => {
    const queue = new SessionFollowupQueue();
    queue.enqueue({
      activeRunId: "run-active",
      sessionId: "session-1",
      requestId: "request-followup",
      displayTask: "补充说明",
      modelTask: "补充说明",
      metadata: {
        custom: "kept",
        run_id: "provisional-run",
        task_id: "provisional-task",
        request_id: "provisional-request",
        execution_kind: "agent_stream",
        source: "client",
        round_index: 0,
      },
      userId: "user-1",
      agent: {} as never,
      provider: {} as never,
      modelName: "model-1",
      selectedLlm: null,
    });

    const timeline: string[] = [];
    const addMessage = vi.fn(async (input: Record<string, unknown>) => {
      timeline.push(`persist:${input.content}`);
      return { id: "message-followup", seq: 17, role: "user", content: input.content } as never;
    });
    const publishOutputMessageSaved = vi.fn(() => {
      timeline.push("message_saved");
    });

    const injected = await persistQueuedFollowupsAtRound({
      storage: { conversation: { addMessage } } as unknown as ExecutionStorage,
      eventPublisher: { publishOutputMessageSaved } as unknown as AgentExecutionEventPublisher,
      followupQueue: queue,
    }, {
      sessionId: "session-1",
      threadKey: "root",
      runId: "run-active",
      agentName: "orchestrator",
      round: 3,
    });

    expect(timeline).toEqual(["persist:补充说明", "message_saved"]);
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      role: "user",
      content: "补充说明",
      threadKey: "root",
      metadata: {
        custom: "kept",
        agent: "orchestrator",
        run_id: "run-active",
        request_id: "request-followup",
        execution_kind: "session_followup",
        source: "running_session",
        round_index: 2,
      },
    }));
    expect(publishOutputMessageSaved).toHaveBeenCalledWith("session-1", "run-active", {
      message_id: "message-followup",
      seq: 17,
      role: "user",
      request_id: "request-followup",
      round_index: 2,
    });
    expect(injected).toEqual([{ message: { role: "user", content: "补充说明" }, seq: 17 }]);
    expect(queue.drain("run-active")).toEqual([]);
  });
});
