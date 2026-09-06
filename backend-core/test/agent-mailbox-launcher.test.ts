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
  const createdAt = new Date(0).toISOString();
  return {
    seq: 1,
    message_id: messageId,
    tenant_id: "tenant-1",
    session_id: "session-1",
    source_run_id: "parent-run",
    source_agent_call_id: "parent-call",
    status: "queued",
    target_run_id: "child-run",
    target_agent_call_id: "child-call",
    target_thread_key: "child:child-1",
    target_child_agent_id: "child-1",
    kind: "request",
    input_type: "agent_message",
    source_kind: "agent",
    visible_to_user: false,
    sent_at: createdAt,
    correlation_id: `corr-${messageId.split("-").at(-1)}`,
    reply_to_message_id: null,
    content_parts: [{ type: "text", text: `request ${messageId}` }],
    metadata: {},
    attempt_count: 0,
    claim_id: `claim-${messageId}`,
    claimed_by: "thread-gate",
    claim_expires_at: null,
    available_at: createdAt,
    expires_at: null,
    last_error: null,
    created_at: createdAt,
    updated_at: createdAt,
    acked_at: null,
  };
}

const session = {
  session_id: "session-1",
  tenant_id: "tenant-1",
  owner_user_id: "owner-9",
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

function threadWakeup() {
  return {
    sessionId: "session-1",
    targetThreadKey: "child:child-1",
    targetChildAgentId: "child-1",
  };
}

/**
 * 按序吐出排队行的认领 mock：每次调用弹出一行（线程闸门一次认领一条头行）。
 * listPending 联动同一队列，drain 循环靠它判断是否继续过闸门。
 */
function sequencedMailbox(rows: ReturnType<typeof queuedChildMessage>[]) {
  const pending = [...rows];
  return {
    claim: vi.fn(async () => {
      const row = pending.shift();
      return row ? [row] : [];
    }),
    listPending: vi.fn(async () => pending.slice(0, 1)),
  };
}

describe("Agent mailbox thread gate (§10.4 round 7)", () => {
  it("dead-letters orphan rows when the thread has no run history", async () => {
    const invoke = vi.fn();
    const orphan = {
      message_id: "orphan-1",
      session_id: "session-1",
      target_thread_key: "child:child-1",
      attempt_count: 1,
      claim_id: "claim-orphan",
    };
    const claim = vi.fn(async () => [orphan]);
    const release = vi.fn(async () => true);
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
      backgroundTasks: null,
      goalStore: null,
      runtimeStorage: {
        operations: { getLatestThreadRun: vi.fn(async () => null) },
      } as never,
      clientEvents: {} as never,
      mailbox: { claim, listPending: vi.fn(async () => []), release } as never,
      runReader: { getRun: vi.fn() } as never,
      participantRuns: { registerParticipantRun: vi.fn(), releaseParticipantRun: vi.fn() },
    });

    launchers.triggerAgentMailboxRun(threadWakeup());
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 无执行历史的线程（正常数据流不可达，多为手工写库/损坏数据）：认领计一次
    // attempt 后释放，让死信机制封顶空转，而不是 60s 扫描无限重敲。
    expect(invoke).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "orphan-1",
      lastError: "thread has no run history",
    }));
  });

  it("continues a terminal child while the session is busy and returns its result to the parent", async () => {
    const getLatestThreadRun = vi.fn(async () => childRun);
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
      // wakeRowRecipient 读回投行的线程字段做路由（root → 空闲闸门）。
      target_thread_key: input.targetThreadKey,
      target_child_agent_id: input.targetChildAgentId ?? null,
      session_id: "session-1",
      status: "queued",
    }));
    const mailboxQueue = sequencedMailbox([queuedChildMessage("request-1"), queuedChildMessage("request-2")]);
    const claim = mailboxQueue.claim;
    const registerParticipantRun = vi.fn(async () => undefined);
    const releaseParticipantRun = vi.fn();
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
      backgroundTasks: { hasRunningTasksDurable, scheduleAutoTrigger: vi.fn() } as never,
      goalStore: null,
      runtimeStorage: { operations: { getActiveRootRun, getLatestThreadRun } } as never,
      clientEvents: {} as never,
      mailbox: {
        enqueue: enqueueMock,
        claim,
        listPending: mailboxQueue.listPending,
        get: vi.fn(async (_sessionId: string, messageId: string) => (
          messageId.includes(":terminal_result") ? null : queuedChildMessage(messageId)
        )),
      } as never,
      runReader: { getRun: vi.fn(async (_s: string, runId: string) => (runId === "parent-run" ? parentRun : null)) as never },
      participantRuns: { registerParticipantRun, releaseParticipantRun },
    });

    launchers.triggerAgentMailboxRun(threadWakeup());
    await waitFor(() => invoke.mock.calls.length === 1);
    finishFirst();
    await waitFor(() => invoke.mock.calls.length === 2);
    await waitFor(() => releaseParticipantRun.mock.calls.length === 2);

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      scope: "child",
      execution: "background",
      executionKind: "system.agent_message",
      // 线程续接无父工具上下文，run 用户身份回退会话 owner。
      userId: "owner-9",
      threadKey: "child:child-1",
      childAgentId: "child-1",
      initialMessage: expect.objectContaining({ id: "request-1" }),
      initialMailboxMessageId: "request-1",
    }));
    const continuationRunId = String(invoke.mock.calls[0]?.[0].runId);
    const continuationCallId = String(invoke.mock.calls[0]?.[0].rootCallId);
    expect(continuationRunId).toMatch(/^mailbox_/);
    expect(registerParticipantRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      childAgentId: "child-1",
      runId: continuationRunId,
      agentCallId: continuationCallId,
      rootRunId: continuationRunId,
    }));
    expect(registerParticipantRun).toHaveBeenCalledTimes(2);
    // 先登记后起 run：登记先于对应 invoke，续跑 run 才有可释放的登记。
    expect(registerParticipantRun.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]!);
    expect(registerParticipantRun.mock.invocationCallOrder[1]).toBeLessThan(invoke.mock.invocationCallOrder[1]!);
    expect(releaseParticipantRun).toHaveBeenCalledWith({
      childAgentId: "child-1",
      runId: continuationRunId,
    });
    // 结果回投按分支寻址（root），run 引用只留 metadata 溯源。
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      targetThreadKey: "root",
      targetChildAgentId: null,
      kind: "result",
      correlationId: "corr-1",
      replyToMessageId: "request-1",
      contentParts: [{ type: "text", text: "已停止工具调用" }],
      metadata: expect.objectContaining({ target_run_id: "parent-run" }),
    }));
    // 子线程闸门不做会话级忙检查：root 运行中照样续跑。
    expect(getActiveRootRun).not.toHaveBeenCalled();
    expect(hasRunningTasksDurable).not.toHaveBeenCalled();
    // 认领口径=纯分支。
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      targetThreadKey: "child:child-1",
      targetChildAgentId: "child-1",
    }));
  });

  it("rechecks a dirty target after the active continuation finishes", async () => {
    const getLatestThreadRun = vi.fn(async () => childRun);
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
        : Promise.resolve({ content: "next", success: true, runId: String(input.runId) }),
    }));
    const mailboxQueue = sequencedMailbox([
      queuedChildMessage("request-1"),
      queuedChildMessage("request-2"),
      queuedChildMessage("request-3"),
    ]);
    const claim = mailboxQueue.claim;
    const participantRuns = {
      registerParticipantRun: vi.fn(async () => undefined),
      releaseParticipantRun: vi.fn(),
    };
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
      backgroundTasks: { hasRunningTasksDurable: vi.fn(), scheduleAutoTrigger: vi.fn() } as never,
      goalStore: null,
      runtimeStorage: { operations: { getLatestThreadRun } } as never,
      clientEvents: {} as never,
      mailbox: {
        enqueue: vi.fn(async (input: Record<string, unknown>) => ({
          message_id: input.messageId,
          correlation_id: input.correlationId,
          target_thread_key: input.targetThreadKey,
          target_child_agent_id: input.targetChildAgentId ?? null,
          session_id: "session-1",
          status: "queued",
        })),
        claim,
        listPending: mailboxQueue.listPending,
        get: vi.fn(async (_sessionId: string, messageId: string) => (
          messageId.includes(":terminal_result") ? null : queuedChildMessage(messageId)
        )),
      } as never,
      runReader: { getRun: vi.fn(async (_s: string, runId: string) => (runId === "parent-run" ? parentRun : null)) as never },
      participantRuns,
    });

    launchers.triggerAgentMailboxRun(threadWakeup());
    await waitFor(() => invoke.mock.calls.length === 1);
    // 续跑在飞时新的唤醒到达：合并为 dirty，完成后由 drain 循环继续过闸门，
    // 逐行消化到队列清空（request-2、request-3 各起一次续跑）。
    launchers.triggerAgentMailboxRun(threadWakeup());
    finishFirst();
    await waitFor(() => invoke.mock.calls.length === 3);
    await waitFor(() => participantRuns.releaseParticipantRun.mock.calls.length >= 3);

    expect(invoke.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      threadKey: "child:child-1",
      rootRunId: invoke.mock.calls[1]?.[0].runId,
      initialMessage: expect.objectContaining({ id: "request-2" }),
    }));
    expect(invoke.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
      initialMessage: expect.objectContaining({ id: "request-3" }),
    }));
    expect(participantRuns.registerParticipantRun).toHaveBeenCalledTimes(3);
  });

  it("routes a root-recipient wake through the idle gate, not the thread gate", async () => {
    const getLatestThreadRun = vi.fn(async () => parentRun);
    const invoke = vi.fn();
    const claim = vi.fn(async () => []);
    // 空闲闸门跑 busy 检查后早退（会话忙），不触线程闸门。
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: { getSession: vi.fn(async () => session) } as never,
      runtimeCore: {} as never,
      slashCommandHandler: {} as never,
      attachmentResolver: {} as never,
      statusTracker: { getStatusBySession: vi.fn(() => ({ status: "running" })) } as never,
      eventPublisher: {} as never,
      runEngine: {} as never,
      invocationService: { invoke } as never,
      backgroundTasks: { hasRunningTasksDurable: vi.fn(async () => false), scheduleAutoTrigger: vi.fn() } as never,
      goalStore: null,
      runtimeStorage: { operations: { getLatestThreadRun } } as never,
      clientEvents: {} as never,
      mailbox: { claim, listPending: vi.fn(async () => []) } as never,
      runReader: { getRun: vi.fn() } as never,
      participantRuns: { registerParticipantRun: vi.fn(), releaseParticipantRun: vi.fn() },
    });

    launchers.triggerAgentMailboxRun({
      sessionId: "session-1",
      targetThreadKey: "root",
      targetChildAgentId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(invoke).not.toHaveBeenCalled();
    expect(getLatestThreadRun).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("recovers durable request correlation when a resumed child reports completion", async () => {
    const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      correlation_id: input.correlationId,
      target_thread_key: input.targetThreadKey,
      target_child_agent_id: input.targetChildAgentId ?? null,
      session_id: "session-1",
      status: "queued",
    }));
    const get = vi.fn(async (_sessionId: string, messageId: string) => (
      messageId.includes(":terminal_result") ? null : { correlation_id: "correlation-1" }
    ));
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
      backgroundTasks: null,
      goalStore: null,
      runtimeStorage: { operations: { getActiveRootRun: vi.fn() } } as never,
      clientEvents: {} as never,
      mailbox: { enqueue, get, listPending: vi.fn(async () => []) } as never,
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
      targetThreadKey: "root",
      targetChildAgentId: null,
    }));
  });
});
