import { describe, expect, it, vi } from "vitest";
import { partsToPlainText } from "@ragsystem/agent-protocol";
import type { ToolExecContext } from "@ragsystem/agent-sdk";
import { TaskToolService } from "../src/tools/TaskTools/TaskExecution.js";
import { GoalUserInterrupt, assertGoalMutationAllowed, type Goal, type GoalStore } from "../src/contracts/runtime/goals.js";
import { buildTerminalAssistantMessage } from "../src/contracts/storage/runtime-finalization.js";
import { createSessionControl } from "../src/services/agent/execution/session-control.js";
import { AgentExecutionStatusTracker } from "../src/services/agent/execution/status-tracker.js";

function harness() {
  let goal = {
    id: "96c4a67c-efbd-4f22-8036-a6524ef978c1", session_id: "session-1", objective: "完成报告",
    status: "active", continuation_generation: 1, steps: [], checkpoint: {}, progress: {},
  } as unknown as Goal;
  const update = vi.fn<GoalStore["update"]>(async (_sid, _id, patch, guard) => {
    assertGoalMutationAllowed(goal, guard);
    goal = { ...goal, ...patch, continuation_generation: goal.continuation_generation + (patch.status && patch.status !== goal.status ? 1 : 0) } as Goal;
    return { ...goal };
  });
  const store = {
    getCurrent: vi.fn(async () => ({ ...goal })), get: vi.fn(async () => ({ ...goal })),
    list: vi.fn(async () => [{ ...goal }]), update,
  } as unknown as GoalStore;
  const service = new TaskToolService({} as never, store);
  return { store, service, update, goal: () => goal };
}

function context(signal: AbortSignal, extra: Partial<ToolExecContext> = {}): ToolExecContext {
  return { sessionId: "session-1", signal, executionKind: "agent_stream", ...extra } as ToolExecContext;
}

describe("Goal interruption", () => {
  it("persists pause before abort and carries the pause into the existing terminal message", async () => {
    const { store, goal } = harness();
    const statusTracker = new AgentExecutionStatusTracker();
    const controller = new AbortController();
    statusTracker.registerRun("run-1", controller);
    statusTracker.register("task-1", "session-1", {
      abortController: controller, promise: Promise.resolve(),
      status: { run_id: "run-1", status: "running" } as never,
    });
    const pausedAtAbort = vi.fn(() => goal().status);
    controller.signal.addEventListener("abort", pausedAtAbort);
    const control = createSessionControl({ statusTracker, goalStore: store,
      eventPublisher: { publishUserInterrupt: vi.fn() },
    } as never);
    expect(await control.stopSession("session-1")).toBe(true);
    expect(pausedAtAbort.mock.results[0]?.value).toBe("paused");
    expect(controller.signal.reason).toBeInstanceOf(GoalUserInterrupt);
    const terminal = buildTerminalAssistantMessage({
      sessionId: "session-1", runId: "run-1", threadKey: "root", agentName: "agent",
      terminalStatus: "interrupted", reason: "session_stopped",
      salvage: { content: "已完成第一部分", pausedGoal: controller.signal.reason.pausedGoal },
    });
    expect(terminal.messageId).toBe("run-1:terminal");
    expect(partsToPlainText(terminal.contentParts)).toContain("已完成第一部分");
    expect(partsToPlainText(terminal.contentParts)).toContain("目标「完成报告」已暂停");
    expect(terminal.metadata).toMatchObject({ terminal_status: "interrupted" });
  });

  it("keeps content-only edits paused and permits an explicit resume from a new user run", async () => {
    const { service, store, goal } = harness();
    await store.update("session-1", goal().id, { status: "paused" });
    const controller = new AbortController();
    await service.captureGoalRun("session-1", controller.signal);
    const edited = await service.goalUpdate({ progress: { done: 2 } }, context(controller.signal));
    expect(edited.success).toBe(true);
    expect(edited.content).toMatchObject({ status: "paused", auto_continuation: false });
    expect(edited.summary).toContain("仍暂停");
    const resumed = await service.goalUpdate({ status: "active" }, context(controller.signal));
    expect(resumed.success).toBe(true);
    expect(resumed.content).toMatchObject({ status: "active", status_change: { from: "paused", to: "active" } });
    expect((await service.goalUpdate({ progress: { done: 3 } }, context(controller.signal))).success).toBe(true);
  });

  it("cannot refresh an old run's write fence by reading the paused Goal", async () => {
    const { service, store, goal } = harness();
    const old = new AbortController();
    await service.captureGoalRun("session-1", old.signal);
    await store.update("session-1", goal().id, { status: "paused" });
    expect((await service.goalGet({}, context(old.signal))).content).toMatchObject({ goal: { status: "paused" } });
    const result = await service.goalUpdate({ status: "active", progress: { overwritten: true } }, context(old.signal));
    expect(result.success).toBe(false);
    expect(goal()).toMatchObject({ status: "paused", progress: {} });
  });

  it.each([{ executionKind: "system.bg_notification" }, { parentRunId: "old-parent" }])(
    "prevents background work from resuming a paused Goal: %j", async (extra) => {
      const { service, store, goal } = harness();
      await store.update("session-1", goal().id, { status: "paused" });
      const controller = new AbortController();
      await service.captureGoalRun("session-1", controller.signal);
      expect((await service.goalUpdate({ status: "active" }, context(controller.signal, extra))).success).toBe(false);
      expect(goal().status).toBe("paused");
    },
  );

  it("rejects calls after abort even when the Goal generation is unchanged", async () => {
    const { service, update } = harness();
    const controller = new AbortController();
    await service.captureGoalRun("session-1", controller.signal);
    controller.abort(new Error("user_stop"));
    expect((await service.goalUpdate({ progress: { done: 1 } }, context(controller.signal))).success).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
