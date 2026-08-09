import { describe, expect, it, vi } from "vitest";

import type { AgentSessionRepositoryPort } from "../src/contracts/session/agent-session-repository.js";
import type { RunStepInfo } from "../src/contracts/common.js";
import { AgentSessionApplication } from "../src/services/sessions/index.js";
import { EXECUTION_ENVELOPE_STEP_TYPE } from "../src/services/runtime/event-outbox/execution-envelope-archive.js";

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
  it("aggregates the selected Run tree and paginates the execution envelopes", async () => {
    const steps = new Map([
      ["child-run", [executionStep("child-run", "child-call", 1)]],
      ["grandchild-run", [executionStep("grandchild-run", "grandchild-call", 2)]],
    ]);
    const listRunSteps = vi.fn(async ({ runId }: { runId?: string | null }) => steps.get(runId || "") || []);
    const repository = {
      listRuns: vi.fn(async () => ({
        items: [
          { run_id: "child-run", parent_run_id: "root-run", created_at: "2026-08-09T00:00:01.000Z" },
          { run_id: "grandchild-run", parent_run_id: "child-run", created_at: "2026-08-09T00:00:02.000Z" },
        ],
        total: 2,
      })),
      listRunSteps,
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const result = await sessions.listRunExecutionSteps({
      sessionId: "session-1",
      runId: "child-run",
      limit: 1,
      offset: 1,
    });

    expect(result).toMatchObject({ run_id: "child-run", total: 2, limit: 1, offset: 1, has_more: false });
    expect(result.items[0]?.call_id).toBe("grandchild-call");
    expect(listRunSteps.mock.calls.map(([input]) => input.runId)).toEqual(["child-run", "grandchild-run"]);
  });

  it("rejects a Run outside the session", async () => {
    const repository = {
      listRuns: vi.fn(async () => ({ items: [], total: 0 })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    await expect(sessions.listRunExecutionSteps({
      sessionId: "session-1",
      runId: "missing-run",
    })).rejects.toThrow("Run 不存在: missing-run");
  });
});
