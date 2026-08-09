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

function queuedChildMessage(messageId: string) {
  return {
    message_id: messageId,
    session_id: "session-1",
    status: "queued",
    target_run_id: "child-run",
    target_agent_call_id: "child-call",
    target_thread_key: "child:child-1",
    target_child_agent_id: "child-1",
    correlation_id: `corr-${messageId.split("-").at(-1)}`,
    metadata: {
      target_agent_name: "worker",
      target_root_run_id: "child-run",
      target_parent_run_id: "parent-run",
      target_parent_call_id: "parent-tool-call",
      target_lineage_parent_call_id: "parent-call",
    },
  };
}

describe("Agent mailbox continuation launcher", () => {
  it("rejects a mailbox wakeup whose durable target lineage does not match", async () => {
    const invoke = vi.fn();
    const mailbox = {
      get: vi.fn(),
      enqueue: vi.fn(),
      listPending: vi.fn(),
    };
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: { getSession: vi.fn() } as never,
      runtimeCore: {} as never,
      slashCommandHandler: {} as never,
      attachmentResolver: {} as never,
      statusTracker: { getStatusBySession: vi.fn(() => ({ status: "idle" })) } as never,
      eventPublisher: {} as never,
      runEngine: {} as never,
      invocationService: { invoke } as never,
      notificationQueue: {} as never,
      backgroundTasks: null,
      goalStore: null,
      runtimeStorage: { operations: {} } as never,
      clientEvents: {} as never,
      mailbox: mailbox as never,
      runReader: {
        getRun: vi.fn(async () => ({
          session_id: "session-1",
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
        })) as never,
      },
      participantRuns: { registerParticipantRun: vi.fn(), releaseParticipantRun: vi.fn() },
    });

    launchers.triggerAgentMailboxRun({
      sessionId: "session-1",
      targetRunId: "child-run",
      targetAgentCallId: "child-call",
      targetThreadKey: "child:child-1",
      targetChildAgentId: "child-1",
      targetAgentName: "worker",
      targetRootRunId: "child-run",
      targetParentRunId: "forged-parent-run",
      targetParentCallId: "parent-tool-call",
      targetLineageParentCallId: "parent-call",
      sourceMessageId: "request-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(invoke).not.toHaveBeenCalled();
    expect(mailbox.get).not.toHaveBeenCalled();
  });

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
      session_id: "session-1",
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
      session_id: "session-1",
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
    let continuationRunId: string | null = null;
    let continuationCallId: string | null = null;
    const getRun = vi.fn(async (_sessionId: string, runId: string) => {
      if (runId === "child-run") return childRun as never;
      if (runId === "parent-run") return parentRun as never;
      if (runId === continuationRunId) {
        return {
          ...childRun,
          run_id: continuationRunId,
          agent_call_id: continuationCallId,
          lease_root_run_id: continuationRunId,
          status: "completed",
        } as never;
      }
      return null;
    });
    let finishFirst!: () => void;
    const firstOutcome = new Promise<void>((resolve) => { finishFirst = resolve; });
    const invoke = vi.fn((input: Record<string, unknown>) => ({
      started: true,
      session_id: "session-1",
      run_id: String(input.runId),
      task_id: String(input.taskId),
      request_id: String(input.requestId),
      kind: "agent_run" as const,
      durableStarted: Promise.resolve({ kind: "started" as const }),
      promise: invoke.mock.calls.length === 1
        ? firstOutcome.then(() => ({
            content: "已停止工具调用",
            contentParts: [{ type: "text" as const, text: "已停止工具调用" }],
            success: true,
            runId: String(input.runId),
          }))
        : Promise.resolve({
            content: "已处理后续消息",
            contentParts: [{ type: "text" as const, text: "已处理后续消息" }],
            success: true,
            runId: String(input.runId),
          }),
    }));
    const enqueueMock = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      correlation_id: input.correlationId,
    }));
    const registerParticipantRun = vi.fn(async () => undefined);
    const releaseParticipantRun = vi.fn();
    let continuationPending = true;
    const listPending = vi.fn(async (input: { targetRunId?: string | null }) => {
      if (!continuationPending || input.targetRunId !== continuationRunId) return [];
      continuationPending = false;
      return [{
        message_id: "request-2",
        session_id: "session-1",
        target_run_id: continuationRunId,
        target_agent_call_id: continuationCallId,
        target_thread_key: "child:child-1",
        target_child_agent_id: "child-1",
        correlation_id: "corr-2",
        metadata: {
          target_agent_name: "worker",
          target_root_run_id: continuationRunId,
          target_parent_run_id: "parent-run",
          target_parent_call_id: "parent-tool-call",
          target_lineage_parent_call_id: "parent-call",
        },
      }];
    });
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
      mailbox: {
        enqueue: enqueueMock,
        listPending,
        get: vi.fn(async (_sessionId, messageId) => ({
          ...queuedChildMessage(messageId),
          ...(messageId === "request-2" && continuationRunId
            ? {
                target_run_id: continuationRunId,
                target_agent_call_id: continuationCallId,
                metadata: {
                  ...queuedChildMessage(messageId).metadata,
                  target_root_run_id: continuationRunId,
                },
              }
            : {}),
        })),
      } as never,
      runReader: { getRun },
      participantRuns: { registerParticipantRun, releaseParticipantRun },
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
    await waitFor(() => invoke.mock.calls.length === 1);
    continuationRunId = String(invoke.mock.calls[0]?.[0].runId);
    continuationCallId = String(invoke.mock.calls[0]?.[0].rootCallId);
    finishFirst();
    await waitFor(() => invoke.mock.calls.length === 2);
    await waitFor(() => releaseParticipantRun.mock.calls.length === 2);

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      scope: "child",
      execution: "background",
      executionKind: "system.agent_message",
      mailboxTargetRunId: "child-run",
      mailboxTargetAgentCallId: "child-call",
    }));
    expect(registerParticipantRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      childAgentId: "child-1",
      runId: continuationRunId,
      agentCallId: continuationCallId,
      replacesRunId: "child-run",
      rootRunId: continuationRunId,
    }));
    expect(registerParticipantRun.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]!);
    expect(releaseParticipantRun).toHaveBeenCalledWith({
      childAgentId: "child-1",
      runId: continuationRunId,
    });
    expect(invoke.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      mailboxTargetRunId: continuationRunId,
      mailboxTargetAgentCallId: continuationCallId,
    }));
    expect(registerParticipantRun).toHaveBeenCalledTimes(2);
    expect(listPending).toHaveBeenCalledWith(expect.objectContaining({
      targetRunId: continuationRunId,
      targetAgentCallId: continuationCallId,
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

  it("rechecks a dirty target after the active continuation finishes", async () => {
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
      session_id: "session-1",
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
      session_id: "session-1",
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
    let finishFirst!: () => void;
    const firstOutcome = new Promise<void>((resolve) => { finishFirst = resolve; });
    const invoke = vi.fn((input: Record<string, unknown>) => ({
      started: true,
      session_id: "session-1",
      run_id: String(input.runId),
      task_id: String(input.taskId),
      request_id: String(input.requestId),
      kind: "agent_run" as const,
      durableStarted: Promise.resolve({ kind: "started" as const }),
      promise: invoke.mock.calls.length === 1
        ? firstOutcome.then(() => ({ content: "first", success: true, runId: String(input.runId) }))
        : Promise.resolve({ content: "second", success: true, runId: String(input.runId) }),
    }));
    let oldTargetChecks = 0;
    let launchers!: ReturnType<typeof createLaunchers>;
    let target!: Parameters<typeof launchers.triggerAgentMailboxRun>[0];
    const listPending = vi.fn((input: { targetRunId?: string | null }) => {
      if (input.targetRunId !== "child-run") return Promise.resolve([]);
      oldTargetChecks += 1;
      if (oldTargetChecks === 1) {
        return Promise.resolve([{
          message_id: "request-2",
          session_id: "session-1",
          target_run_id: "child-run",
          target_agent_call_id: "child-call",
          target_thread_key: "child:child-1",
          target_child_agent_id: "child-1",
          correlation_id: "corr-2",
          metadata: {
            target_agent_name: "worker",
            target_root_run_id: "child-run",
            target_parent_run_id: "parent-run",
            target_parent_call_id: "parent-tool-call",
            target_lineage_parent_call_id: "parent-call",
          },
        }]);
      }
      if (oldTargetChecks === 2) {
        return new Promise<never[]>((resolve) => {
          resolve([]);
          queueMicrotask(() => {
            queueMicrotask(() => {
              queueMicrotask(() => launchers.triggerAgentMailboxRun({
                  ...target,
                  sourceMessageId: "request-3",
                  correlationId: "corr-3",
              }));
            });
          });
        });
      }
      return Promise.resolve([]);
    });
    const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      correlation_id: input.correlationId,
    }));
    const participantRuns = {
      registerParticipantRun: vi.fn(async () => undefined),
      releaseParticipantRun: vi.fn(),
    };
    launchers = createLaunchers({
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
      backgroundTasks: { hasRunningTasksDurable: vi.fn(), scheduleAutoTrigger: vi.fn() } as never,
      goalStore: null,
      runtimeStorage: { operations: { getActiveRootRun: vi.fn() } } as never,
      clientEvents: {} as never,
      mailbox: { enqueue, listPending, get: vi.fn(async (_sessionId, messageId) => queuedChildMessage(messageId)) } as never,
      runReader: {
        getRun: vi.fn(async (_sessionId: string, runId: string) => (
          runId === "child-run" ? childRun : runId === "parent-run" ? parentRun : null
        )) as never,
      },
      participantRuns,
    });
    target = {
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
    };

    launchers.triggerAgentMailboxRun(target);
    await waitFor(() => invoke.mock.calls.length === 1);
    launchers.triggerAgentMailboxRun({ ...target, sourceMessageId: "request-2", correlationId: "corr-2" });
    finishFirst();
    await waitFor(() => invoke.mock.calls.length >= 2);
    await waitFor(() => participantRuns.releaseParticipantRun.mock.calls.length >= 3);
    await waitFor(() => oldTargetChecks >= 2);

    expect(invoke.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      mailboxTargetRunId: "child-run",
      mailboxTargetAgentCallId: "child-call",
      rootRunId: invoke.mock.calls[1]?.[0].runId,
    }));
    expect(invoke.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
      mailboxTargetRunId: "child-run",
      mailboxTargetAgentCallId: "child-call",
      rootRunId: invoke.mock.calls[2]?.[0].runId,
    }));
    expect(participantRuns.registerParticipantRun).toHaveBeenCalledTimes(3);
  });

  it("recovers durable request correlation when a resumed child reports completion", async () => {
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
    const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      correlation_id: input.correlationId,
    }));
    const get = vi.fn(async () => ({ correlation_id: "correlation-1" }));
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: {} as never,
      runtimeCore: {} as never,
      slashCommandHandler: {} as never,
      attachmentResolver: {} as never,
      statusTracker: { getStatusBySession: vi.fn(() => ({ status: "suspended" })) } as never,
      eventPublisher: {} as never,
      runEngine: {} as never,
      invocationService: {} as never,
      notificationQueue: {} as never,
      backgroundTasks: null,
      goalStore: null,
      runtimeStorage: { operations: { getActiveRootRun: vi.fn() } } as never,
      clientEvents: {} as never,
      mailbox: { enqueue, get } as never,
      runReader: { getRun: vi.fn(async () => parentRun) } as never,
      participantRuns: {} as never,
    });

    await launchers.completeAgentMailboxContinuation({
      sessionId: "session-1",
      sourceRunId: "mailbox-run",
      sourceAgentCallId: "mailbox-call",
      sourceAgentName: "worker",
      sourceChildAgentId: "child-1",
      parentRunId: "parent-run",
      replyToMessageId: "request-message",
      outcome: {
        content: "done",
        success: true,
        runId: "mailbox-run",
      },
    });

    expect(get).toHaveBeenCalledWith("session-1", "request-message");
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "mailbox-run:terminal_result",
      correlationId: "correlation-1",
      replyToMessageId: "request-message",
      targetRunId: "parent-run",
    }));
  });
});
