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

function boundaryStep(runId: string, messageId: string, order: number): RunStepInfo {
  return {
    ...executionStep(runId, `boundary-call-${order}`, order),
    payload: {
      type: "agent_message",
      session_id: "session-1",
      run_id: runId,
      call_id: `boundary-call-${order}`,
      payload: {
        kind: "request",
        message_id: messageId,
        content: messageId,
      },
    },
  };
}

function assistantBoundaryStep(runId: string, messageId: string, order: number): RunStepInfo {
  return {
    ...executionStep(runId, `assistant-call-${order}`, order),
    payload: {
      type: "stream_output",
      session_id: "session-1",
      run_id: runId,
      message_id: messageId,
      call_id: `assistant-call-${order}`,
      payload: { phase: "final", content: "done" },
    },
  };
}

describe("AgentSessionApplication participant Run steps", () => {
  it("exposes visible input boundaries but not the terminal assistant as execution carriers", async () => {
    const messages = [
      { id: "initial", role: "user", metadata: { run_id: "root-run", consumed_by_run_id: "root-run", execution_kind: "agent_stream" } },
      { id: "followup-source", role: "user", metadata: { run_id: "root-run", source: "running_session" } },
      { id: "followup-kind", role: "user", metadata: { run_id: "root-run", execution_kind: "session_followup" } },
      { id: "agent-message", role: "user", metadata: { run_id: "root-run", agent_message: true } },
      { id: "assistant", role: "assistant", metadata: { run_id: "root-run" } },
    ];
    const repository = {
      listVisibleMessages: vi.fn(async () => ({
        items: messages,
        total: messages.length,
        limit: 20,
        offset: 0,
        has_more: false,
      })),
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const result = await sessions.listMessages({ sessionId: "session-1" });

    expect(result.items.map((item) => [item.id, item.has_execution])).toEqual([
      ["initial", true],
      ["followup-source", true],
      ["followup-kind", true],
      ["agent-message", true],
      ["assistant", false],
    ]);
  });

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

  it("lists only the selected Run and paginates its execution envelopes", async () => {
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

    expect(result).toMatchObject({ run_id: "child-run", total: 1, limit: 1, offset: 1, has_more: false });
    expect(result.items).toEqual([]);
    expect(listRunSteps.mock.calls.map(([input]) => input.runId)).toEqual(["child-run"]);
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

  it("slices a Run from each visible message to the next message boundary", async () => {
    const messages = [
      { id: "initial", role: "user", metadata: { run_id: "root-run", consumed_by_run_id: "root-run" }, thread_key: "root", child_agent_id: null, seq: 1 },
      { id: "followup-1", role: "user", metadata: { run_id: "root-run", consumed_by_run_id: "root-run", source: "running_session" }, thread_key: "root", child_agent_id: null, seq: 2 },
      { id: "agent-1", role: "user", metadata: { run_id: "root-run", consumed_by_run_id: "root-run", agent_message: true }, thread_key: "root", child_agent_id: null, seq: 3 },
      { id: "assistant", role: "assistant", metadata: { run_id: "root-run" }, thread_key: "root", child_agent_id: null, seq: 4 },
    ];
    const steps = [
      executionStep("root-run", "call-1", 1),
      executionStep("root-run", "call-2", 2),
      boundaryStep("root-run", "followup-1", 3),
      executionStep("root-run", "call-3", 4),
      boundaryStep("root-run", "agent-1", 5),
      executionStep("root-run", "call-4", 6),
      assistantBoundaryStep("root-run", "assistant", 7),
    ];
    const segments = new Map<string, RunStepInfo[]>([
      ["initial", steps.slice(0, 2)],
      ["followup-1", steps.slice(3, 4)],
      ["agent-1", steps.slice(5, 6)],
      ["assistant", []],
    ]);
    const listMessageRunSteps = vi.fn(async ({
      messageId,
      offset,
      limit,
    }: { messageId: string; offset: number; limit: number }) => {
      const items = segments.get(messageId) ?? [];
      return { items: items.slice(offset, offset + limit), total: items.length };
    });
    const repository = {
      getMessageById: vi.fn(async (_sessionId: string, messageId: string) => (
        messages.find((message) => message.id === messageId) ?? null
      )),
      listMessageRunSteps,
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const initial = await sessions.listMessageRunSteps({ sessionId: "session-1", messageId: "initial", limit: 50 });
    const followup = await sessions.listMessageRunSteps({ sessionId: "session-1", messageId: "followup-1", limit: 50 });
    const agentMessage = await sessions.listMessageRunSteps({ sessionId: "session-1", messageId: "agent-1", limit: 50 });
    const final = await sessions.listMessageRunSteps({ sessionId: "session-1", messageId: "assistant", limit: 50 });

    expect(initial.items.map((item) => item.call_id)).toEqual(["call-1", "call-2"]);
    expect(followup.items.map((item) => item.call_id)).toEqual(["call-3"]);
    expect(agentMessage.items.map((item) => item.call_id)).toEqual(["call-4"]);
    expect(final.items).toEqual([]);
    expect(listMessageRunSteps).toHaveBeenCalledTimes(4);
    expect(listMessageRunSteps).toHaveBeenCalledWith({
      sessionId: "session-1",
      runId: "root-run",
      messageId: "followup-1",
      limit: 50,
      offset: 0,
    });
  });

  it("delegates rollback truncation to the repository transaction", async () => {
    const deleteMessagesAfter = vi.fn(async () => 2);
    const repository = {
      deleteMessagesAfter,
    } as unknown as AgentSessionRepositoryPort;
    const sessions = new AgentSessionApplication(repository);

    const deleted = await sessions.rollbackMessages({ sessionId: "session-1", afterSeq: 1 });

    expect(deleted).toBe(2);
    expect(deleteMessagesAfter).toHaveBeenCalledWith("session-1", {
      afterSeq: 1,
    });
  });
});
