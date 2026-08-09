import { describe, expect, it, vi } from "vitest";

import { AgentConfigSchema } from "../src/contracts/agent/agent-config.js";
import { createLaunchers } from "../src/services/agent/execution/launchers.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

const parentAgent = AgentConfigSchema.parse({
  agent_name: "parent",
  llm_tiers: { default: { provider: "provider", model_name: "model" } },
});
const workerAgent = AgentConfigSchema.parse({
  agent_name: "worker",
  llm_tiers: { default: { provider: "provider", model_name: "model" } },
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Agent mailbox continuation launcher", () => {
  it("continues a terminal child while the root is running and returns its result to the parent", async () => {
    const session = {
      session_id: "session-1",
      tenant_id: "tenant-1",
      owner_user_id: null,
      visibility: "private",
      origin_type: "direct",
      origin_id: null,
      origin_channel: "api",
      workspace_id: null,
      team_snapshot: createTestTeamSnapshot("parent", [parentAgent, workerAgent]),
      permission_mode: null,
      metadata: {},
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    const childRun = {
      run_id: "child-run",
      status: "completed",
      agent_call_id: "child-call",
      agent_name: "worker",
      agent_display_name: "Worker",
      lease_root_run_id: "child-run",
      thread_key: "child:child-1",
      child_agent_id: "child-1",
      parent_run_id: "parent-run",
      parent_call_id: "parent-tool-call",
      lineage_parent_call_id: "parent-call",
    };
    const parentRun = {
      run_id: "parent-run",
      status: "completed",
      agent_call_id: "parent-call",
      agent_name: "parent",
      agent_display_name: "Parent",
      lease_root_run_id: "parent-run",
      thread_key: "root",
      child_agent_id: null,
      parent_run_id: null,
      parent_call_id: null,
      lineage_parent_call_id: null,
    };
    const getRun = vi.fn(async (_sessionId: string, runId: string) => (
      runId === "child-run" ? childRun : runId === "parent-run" ? parentRun : null
    ) as never);
    const invoke = vi.fn((input: Record<string, unknown>) => ({
      started: true,
      session_id: "session-1",
      run_id: String(input.runId),
      task_id: String(input.taskId),
      request_id: String(input.requestId),
      kind: "agent_run" as const,
      durableStarted: Promise.resolve({ kind: "started" as const }),
      promise: Promise.resolve({
        content: "已停止工具调用",
        contentParts: [{ type: "text" as const, text: "已停止工具调用" }],
        success: true,
        runId: String(input.runId),
      }),
    }));
    const enqueueMock = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      correlation_id: input.correlationId,
    }));
    const hasRunningTasksDurable = vi.fn(async () => true);
    const getActiveRootRun = vi.fn(async () => ({ runId: "active-root-run" }));
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: { getSession: vi.fn(async () => session) } as never,
      runtimeCore: {
        resolveExecutionConfig: vi.fn(() => ({
          readiness: { configuration_ready: true, requirements: [] },
          agent: workerAgent,
          provider: { key: "provider", name: "Provider", provider_type: "openai" },
          modelName: "model",
        })),
      } as never,
      slashCommandHandler: {} as never,
      attachmentResolver: {} as never,
      statusTracker: { getStatusBySession: vi.fn(() => ({ status: "running" })) } as never,
      eventPublisher: {} as never,
      runEngine: {} as never,
      invocationService: { invoke } as never,
      notificationQueue: {} as never,
      backgroundTasks: { hasRunningTasksDurable, scheduleAutoTrigger: vi.fn() } as never,
      goalStore: null,
      runtimeStorage: { operations: { getActiveRootRun } } as never,
      clientEvents: {} as never,
      mailbox: { enqueue: enqueueMock } as never,
      runReader: { getRun },
    });

    launchers.triggerAgentMailboxRun({
      sessionId: "session-1",
      targetRunId: "child-run",
      targetAgentCallId: "child-call",
      targetThreadKey: "child:child-1",
      targetChildAgentId: "child-1",
      targetAgentName: "worker",
      targetRootRunId: "child-run",
      targetParentRunId: "parent-run",
      targetParentCallId: "parent-tool-call",
      targetLineageParentCallId: "parent-call",
      sourceMessageId: "request-1",
      correlationId: "corr-1",
    });
    await waitFor(() => enqueueMock.mock.calls.length === 1);

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      scope: "child",
      execution: "background",
      executionKind: "system.agent_message",
      mailboxTargetRunId: "child-run",
      mailboxTargetAgentCallId: "child-call",
    }));
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      targetRunId: "parent-run",
      targetAgentCallId: "parent-call",
      targetThreadKey: "root",
      kind: "result",
      correlationId: "corr-1",
      replyToMessageId: "request-1",
      contentParts: [{ type: "text", text: "已停止工具调用" }],
    }));
    expect(getActiveRootRun).not.toHaveBeenCalled();
    expect(hasRunningTasksDurable).not.toHaveBeenCalled();
  });
});
