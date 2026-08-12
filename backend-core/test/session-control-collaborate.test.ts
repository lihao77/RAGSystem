import { describe, expect, it, vi } from "vitest";

import { createSessionControl } from "../src/services/agent/execution/session-control.js";
import type { AgentExecuteResult, CollaborateRequest } from "../src/contracts/execution/execution.js";
import { AgentExecutionStatusTracker } from "../src/services/agent/execution/status-tracker.js";

function result(sessionId: string, task: string, success = true): AgentExecuteResult {
  return {
    success,
    answer: success ? task : null,
    content_parts: [{ type: "text", text: task }],
    agent_name: null,
    execution_time: 0,
    tool_calls: [],
    metadata: {},
    session_id: sessionId,
    run_id: null,
    task_id: null,
    error: success ? null : task,
  };
}

function request(mode: "sequential" | "parallel"): CollaborateRequest {
  return {
    mode,
    session_id: "session-collaborate",
    userId: "user-1" as CollaborateRequest["userId"],
    tasks: [
      { task: "one", agent: "worker-a" },
      { task: "two", agent: "worker-b" },
      { task: "three", agent: "worker-c" },
    ],
  };
}

describe("collaborate fan-out", () => {
  it("runs independent tasks concurrently and preserves input order", async () => {
    let active = 0;
    let maxActive = 0;
    const executeSynchronously = vi.fn(async (input: { task: string }, requestId: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, input.task === "one" ? 15 : 5));
      active -= 1;
      return result("session-collaborate", `${requestId}:${input.task}`);
    });
    const control = createSessionControl({ executeSynchronously } as never);

    const output = await control.collaborate(request("parallel"), "req");

    expect(maxActive).toBeGreaterThan(1);
    expect(output.results).toHaveLength(3);
    expect(output.results.map((item) => item.answer)).toEqual([
      "req:1:one",
      "req:2:two",
      "req:3:three",
    ]);
  });

  it("isolates one parallel task failure", async () => {
    const executeSynchronously = vi.fn(async (input: { task: string }) => {
      if (input.task === "two") throw new Error("worker failed");
      return result("session-collaborate", input.task);
    });
    const control = createSessionControl({ executeSynchronously } as never);

    const output = await control.collaborate(request("parallel"), "req");

    expect(output.results.map((item) => item.success)).toEqual([true, false, true]);
    expect(output.results[1]?.metadata).toEqual(expect.objectContaining({ isolated_failure: true }));
  });

  it("keeps sequential mode fail-fast", async () => {
    const executeSynchronously = vi.fn(async (input: { task: string }) => result("session-collaborate", input.task, input.task !== "two"));
    const control = createSessionControl({ executeSynchronously } as never);

    const output = await control.collaborate(request("sequential"), "req");

    expect(output.results.map((item) => item.answer)).toEqual(["one", null]);
    expect(executeSynchronously).toHaveBeenCalledTimes(2);
  });
});

describe("session cancellation", () => {
  it("stops the foreground root through the shared run-id canceller", async () => {
    const statusTracker = new AgentExecutionStatusTracker();
    const abortController = new AbortController();
    statusTracker.registerRun("run-1", abortController);
    statusTracker.register("task-1", "session-1", {
      abortController,
      promise: Promise.resolve(),
      status: {
        task_id: "task-1",
        session_id: "session-1",
        run_id: "run-1",
        request_id: "request-1",
        execution_kind: "agent_stream",
        task: "work",
        status: "running",
        elapsed_seconds: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        thread_alive: true,
      },
    });
    const publishUserInterrupt = vi.fn();
    const control = createSessionControl({ statusTracker, eventPublisher: { publishUserInterrupt } } as never);

    await expect(control.stopSession("session-1")).resolves.toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect((abortController.signal.reason as Error).message).toBe("user_stop");
    expect(publishUserInterrupt).toHaveBeenCalledOnce();
  });
});
