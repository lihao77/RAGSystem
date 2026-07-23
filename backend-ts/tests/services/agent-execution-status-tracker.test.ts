import { describe, expect, it } from "vitest";

import { AgentExecutionStatusTracker } from "../../src/services/agent/execution/status-tracker.js";

function handle(taskId: string, status: "running" | "completed") {
  return {
    abortController: new AbortController(),
    status: {
      task_id: taskId,
      session_id: "session-1",
      run_id: `run-${taskId}`,
      status,
      execution_kind: "agent_stream",
      started_at: new Date().toISOString(),
      finished_at: status === "completed" ? new Date().toISOString() : null,
      elapsed_seconds: null,
      thread_alive: status === "running",
      task: taskId,
    },
    promise: Promise.resolve(),
  } as never;
}

describe("AgentExecutionStatusTracker", () => {
  it("does not unregister a newer session handle when an older run finishes", () => {
    const tracker = new AgentExecutionStatusTracker();
    tracker.register("task-old", "session-1", handle("task-old", "completed"));
    tracker.register("task-new", "session-1", handle("task-new", "running"));

    tracker.unregister("task-old", "session-1");

    expect(tracker.getRunningHandleBySession("session-1")?.status.task_id).toBe("task-new");
  });
});
