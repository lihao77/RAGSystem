import { describe, expect, it, vi } from "vitest";

import type { AgentSessionRepositoryPort } from "../src/contracts/session/agent-session-repository.js";
import type { RunStepInfo } from "../src/contracts/common.js";
import { AgentSessionApplication } from "../src/services/sessions/index.js";
import { EXECUTION_ENVELOPE_STEP_TYPE } from "../src/services/runtime/event-outbox/execution-envelope-archive.js";

function run(runId: string, overrides: Partial<{
  status: string;
  task_summary: string | null;
  thread_key: string;
  parent_run_id: string | null;
  child_agent_id: string | null;
  final_message_id: string | null;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    run_id: runId,
    status: "completed",
    task_summary: null,
    thread_key: "child:child-1",
    parent_run_id: null,
    child_agent_id: "child-1",
    final_message_id: `${runId}:final`,
    created_at: "2026-08-09T00:00:01.000Z",
    updated_at: "2026-08-09T00:00:02.000Z",
    ...overrides,
  };
}

function executionStep(runId: string, callId: string, order: number): RunStepInfo {
  return {
    id: order,
    run_id: runId,
    event_id: `${runId}:${order}`,
    session_id: "session-1",
    message_id: null,
    step_order: order,
    step_type: EXECUTION_ENVELOPE_STEP_TYPE,
    payload: {
      type: "agent_started",
      session_id: "session-1",
      run_id: runId,
      call_id: callId,
      agent_id: "worker",
      payload: { phase: "start" },
    },
    created_at: `2026-08-09T00:00:0${order}.000Z`,
  };
}

describe("AgentSessionApplication participant Run steps", () => {
  it("lists every Run owned by the selected participant", async () => {
    const repository = {
      listParticipantRuns: vi.fn(async () => ({
        items: [
          run("child-run-1", { task_summary: "initial" }),
        ],
        total: 2,
      })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const result = await sessions.listParticipantRuns({
      sessionId: "session-1",
      participantId: "child-1",
      limit: 1,
      offset: 1,
    });

    expect(result).toMatchObject({ total: 2, limit: 1, offset: 1, has_more: false });
    expect(result.items.map((item) => item.run_id)).toEqual(["child-run-1"]);
    expect(repository.listParticipantRuns).toHaveBeenCalledWith("session-1", "child-1", 1, 1);
  });

  it("aggregates the selected Run tree and paginates the execution envelopes", async () => {
    const steps = new Map([
      ["child-run", [executionStep("child-run", "child-call", 1)]],
      ["grandchild-run", [executionStep("grandchild-run", "grandchild-call", 2)]],
    ]);
    const listRunSteps = vi.fn(async ({ runId }: { runId?: string | null }) => steps.get(runId || "") || []);
    const childRun = run("child-run", { parent_run_id: "root-run" });
    const repository = {
      getRun: vi.fn(async () => childRun),
      listRuns: vi.fn(async () => ({
        items: [
          childRun,
          run("grandchild-run", { parent_run_id: "child-run", child_agent_id: "child-2", thread_key: "child:child-2", created_at: "2026-08-09T00:00:02.000Z" }),
        ],
        total: 2,
      })),
      listRunSteps,
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const result = await sessions.listParticipantRunExecutionSteps({
      sessionId: "session-1",
      participantId: "child-1",
      runId: "child-run",
      limit: 1,
      offset: 1,
    });

    expect(result).toMatchObject({ run_id: "child-run", total: 2, limit: 1, offset: 1, has_more: false });
    expect(result.items[0]?.call_id).toBe("grandchild-call");
    expect(listRunSteps.mock.calls.map(([input]) => input.runId)).toEqual(["child-run", "grandchild-run"]);
  });

  it("rejects a Run owned by another participant", async () => {
    const repository = {
      getRun: vi.fn(async () => run("other-run", { child_agent_id: "child-2", thread_key: "child:child-2" })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    await expect(sessions.listParticipantRunExecutionSteps({
      sessionId: "session-1",
      participantId: "child-1",
      runId: "other-run",
    })).rejects.toThrow("Run 不存在: other-run");
  });
});
