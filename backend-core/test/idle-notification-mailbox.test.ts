import { describe, expect, it, vi } from "vitest";

import { createLaunchers } from "../src/services/agent/execution/launchers.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

const session = {
  session_id: "session-1",
  tenant_id: "tenant-1",
  owner_user_id: "owner-1",
  visibility: "private",
  origin_type: "direct",
  origin_id: null,
  origin_channel: "api",
  workspace_id: null,
  team_snapshot: createTestTeamSnapshot("parent", [{
    agent_name: "parent",
    display_name: "Parent",
    enabled: true,
  }] as never),
  permission_mode: null,
  metadata: {},
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

function mailboxMessage(input: {
  messageId: string;
  inputType: "user_message" | "system_notification" | "goal_continuation" | "agent_message";
  text: string;
  seq?: number;
  targetThreadKey?: string;
  targetRunId?: string | null;
}) {
  const createdAt = new Date(0).toISOString();
  return {
    seq: input.seq ?? 1,
    message_id: input.messageId,
    tenant_id: "tenant-1",
    session_id: "session-1",
    source_run_id: null,
    source_agent_call_id: null,
    target_run_id: input.targetRunId ?? null,
    target_agent_call_id: null,
    target_thread_key: input.targetThreadKey ?? "root",
    target_child_agent_id: null,
    kind: "request",
    input_type: input.inputType,
    source_kind: input.inputType === "user_message" ? "user" : input.inputType === "agent_message" ? "agent" : "system",
    visible_to_user: input.inputType === "user_message",
    sent_at: createdAt,
    correlation_id: null,
    reply_to_message_id: null,
    content_parts: [{ type: "text", text: input.text }],
    metadata: input.inputType === "user_message"
      ? {}
      : { source: input.inputType === "goal_continuation" ? "goal_continuation" : "background_notification" },
    status: "queued",
    attempt_count: 0,
    claim_id: null as string | null,
    claimed_by: null,
    claim_expires_at: null,
    available_at: createdAt,
    expires_at: null,
    last_error: null,
    created_at: createdAt,
    updated_at: createdAt,
    acked_at: null,
  };
}

function activeGoal(generation = 2) {
  return {
    id: "goal-1",
    status: "active",
    continuation_generation: generation,
    continuation_pending: false,
    continuation_claimed_at: null,
    objective: "完成 TC04 基准",
    success_criteria: ["产出对比报告"],
    steps: [{ id: "s1", title: "跑基准", status: "in_progress", description: null }],
    checkpoint: { last: "round-3" },
    progress: { done: 1 },
  };
}

function createHarness(
  messages: Array<ReturnType<typeof mailboxMessage>>,
  options: { goal?: Record<string, any> | null } = {},
) {
  const goalRef = { value: options.goal ?? null };
  const stored = new Map(messages.map((message) => [message.message_id, { ...message }]));
  const acked: string[] = [];
  // invoke 模拟闸门语义：rootMailboxMessage 引用行在 run 启动事务内被 settle。
  const invoke = vi.fn((input: Record<string, any>) => {
    if (input.rootMailboxMessage) {
      const row = stored.get(input.rootMailboxMessage.id);
      if (row && row.status !== "acked") {
        row.status = "acked";
        acked.push(row.message_id);
      }
    }
    return {
      promise: Promise.resolve({ success: true, content: "" }),
      durableStarted: Promise.resolve({ kind: "started", runId: "run-1" }),
    };
  });
  // appendMailboxMessage 模拟无 run 过路行闸门：enqueue 幂等命中 + settle。
  const appendMailboxMessage = vi.fn(async (input: { mailboxMessage: { messageId: string } }) => {
    const row = stored.get(input.mailboxMessage.messageId);
    if (row && row.status !== "acked") {
      row.status = "acked";
      acked.push(row.message_id);
    }
    return {
      mailboxMessage: row ?? null,
      message: { id: input.mailboxMessage.messageId, seq: 99, content_parts: [] },
    };
  });
  const releaseContinuation = vi.fn(async () => undefined);
  const goalStore = {
    getCurrent: vi.fn(async () => goalRef.value),
    claimContinuation: vi.fn(async () => (goalRef.value ? { ...goalRef.value, continuation_pending: true } : null)),
    releaseContinuation,
    setContinuationReason: vi.fn(async () => undefined),
  };
  const mailbox = {
    get: vi.fn(async (_sessionId: string, messageId: string) => stored.get(messageId) ?? null),
    enqueue: vi.fn(async (input: Record<string, any>) => {
      const createdAt = new Date(0).toISOString();
      const row = {
        seq: stored.size + 1,
        message_id: input.messageId,
        tenant_id: input.tenantId,
        session_id: input.sessionId,
        source_run_id: input.sourceRunId ?? null,
        source_agent_call_id: input.sourceAgentCallId ?? null,
        target_run_id: input.targetRunId ?? null,
        target_agent_call_id: input.targetAgentCallId ?? null,
        target_thread_key: input.targetThreadKey,
        target_child_agent_id: input.targetChildAgentId ?? null,
        kind: input.kind,
        input_type: input.inputType ?? "agent_message",
        source_kind: input.sourceKind ?? "agent",
        visible_to_user: input.visibleToUser ?? false,
        sent_at: input.sentAt ?? null,
        correlation_id: input.correlationId ?? null,
        reply_to_message_id: input.replyToMessageId ?? null,
        content_parts: input.contentParts ?? [],
        metadata: input.metadata ?? {},
        status: "queued",
        attempt_count: 0,
        claim_id: null as string | null,
        claimed_by: null,
        claim_expires_at: null,
        available_at: createdAt,
        expires_at: null,
        last_error: null,
        created_at: createdAt,
        updated_at: createdAt,
        acked_at: null,
      };
      stored.set(row.message_id, row);
      return row;
    }),
    listPending: vi.fn(async () => Array.from(stored.values()).filter((message) => message.status === "queued")),
    claim: vi.fn(async () => {
      // 与真实认领谓词一致（§10.4 第七轮）：纯分支匹配，不看行上的溯源 run 字段。
      const claimable = Array.from(stored.values()).filter((message) => message.status === "queued"
        && message.target_thread_key === "root");
      for (const message of claimable) {
        message.status = "claimed";
        message.claim_id = `claim-${message.message_id}`;
      }
      return claimable.map((message) => ({ ...message }));
    }),
    ack: vi.fn(async (input: { messageId: string }) => {
      const message = stored.get(input.messageId);
      if (message && message.status === "claimed") {
        message.status = "acked";
        acked.push(input.messageId);
      }
      return true;
    }),
    release: vi.fn(async (input: { messageId: string }) => {
      const message = stored.get(input.messageId);
      if (message && message.status === "claimed") message.status = "queued";
      return true;
    }),
    settle: vi.fn(async (input: { messageId: string }) => {
      const message = stored.get(input.messageId);
      if (message && (message.status === "queued" || message.status === "claimed")) {
        message.status = "acked";
        acked.push(input.messageId);
      }
      return true;
    }),
  };
  const scheduleAutoTrigger = vi.fn();
  const runReaderGetRun = vi.fn(async () => null);
  const statusTracker = {
    getStatusBySession: vi.fn((): { status: string; run_id: string; task_id: string | null } | null => null),
  };
  const getLatestThreadRun = vi.fn(async (_sessionId: string, threadKey: string) => {
    threadGateThreads.push(threadKey);
    return null;
  });
  const threadGateThreads: string[] = [];
  const launchers = createLaunchers({
    tenantId: "tenant-1" as never,
    sessions: { getSession: vi.fn(async () => session) } as never,
    runtimeCore: {
      resolveExecutionConfig: vi.fn(() => ({
        readiness: { configuration_ready: true, requirements: [] },
        agent: { agent_name: "parent" },
        provider: { name: "provider" },
        modelName: "model",
      })),
    } as never,
    slashCommandHandler: {} as never,
    attachmentResolver: {} as never,
    statusTracker: statusTracker as never,
    eventPublisher: {} as never,
    runEngine: {} as never,
    invocationService: { invoke } as never,
    backgroundTasks: {
      hasRunningTasksDurable: vi.fn(async () => false),
      scheduleAutoTrigger,
    } as never,
    goalStore: goalStore as never,
    runtimeStorage: { operations: { appendMailboxMessage, getLatestThreadRun } } as never,
    clientEvents: {} as never,
    mailbox: mailbox as never,
    runReader: {
      getRun: runReaderGetRun,
      listRuns: vi.fn(async () => ({ items: [], total: 0 })),
      getMessageById: vi.fn(async () => null),
    } as never,
    participantRuns: { registerParticipantRun: vi.fn(), releaseParticipantRun: vi.fn() },
    logger: { error: vi.fn() },
  });
  return {
    launchers, invoke, mailbox, stored, acked, appendMailboxMessage, statusTracker,
    scheduleAutoTrigger, goalStore, releaseContinuation, runReaderGetRun, threadGateThreads,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("idle background notification consumption from the session mailbox", () => {
  it("consumes queued notifications as one reference row plus materialized companions", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "bgnotify-task-1", inputType: "system_notification", text: "<task-notification><task-id>task-1</task-id></task-notification>", seq: 1 }),
      mailboxMessage({ messageId: "bgnotify-task-2", inputType: "system_notification", text: "<task-notification><task-id>task-2</task-id></task-notification>", seq: 2 }),
    ]);

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await waitFor(() => harness.acked.length === 2);

    const call = harness.invoke.mock.calls[0]![0] as Record<string, any>;
    expect(call.executionKind).toBe("system.bg_notification");
    // 确定性 requestId：由头行 id 派生，崩溃重试不换身份。
    expect(call.requestId).toBe("bg_notify_bgnotify-task-1");
    expect(call.task).toContain("<task-id>task-1</task-id>");
    expect(call.task).toContain("<task-id>task-2</task-id>");
    // 一行一 run：头行直接作为初始消息引用，不合成随机 id 的合并行。
    expect(call.rootMailboxMessage).toEqual(expect.objectContaining({
      id: "bgnotify-task-1",
      inputType: "system_notification",
      sourceKind: "system",
    }));
    expect(call.persistUserMessage).toBeUndefined();
    // 伴随行经 appendMailboxMessage 物化各自的会话消息行并 settle。
    expect(harness.appendMailboxMessage).toHaveBeenCalledTimes(1);
    expect(harness.appendMailboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      mailboxMessage: expect.objectContaining({ messageId: "bgnotify-task-2" }),
    }));
    expect(harness.stored.get("bgnotify-task-1")?.status).toBe("acked");
    expect(harness.stored.get("bgnotify-task-2")?.status).toBe("acked");
  });

  it("consumes all queued user followups in one batched run", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "user-followup-1", inputType: "user_message", text: "第一条排队消息", seq: 1 }),
      mailboxMessage({ messageId: "user-followup-2", inputType: "user_message", text: "第二条排队消息", seq: 2 }),
      mailboxMessage({ messageId: "user-followup-3", inputType: "user_message", text: "第三条排队消息", seq: 3 }),
    ]);

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await waitFor(() => harness.stored.get("user-followup-3")?.status === "acked");

    const call = harness.invoke.mock.calls[0]![0] as Record<string, any>;
    expect(call.executionKind).toBe("session_followup");
    expect(call.requestId).toBe("session_followup_user-followup-1");
    // 头行引用 + 伴随行物化：一轮 run 消化全部排队用户消息，不链式起 run。
    expect(call.rootMailboxMessage).toEqual(expect.objectContaining({ id: "user-followup-1" }));
    expect(call.task).toContain("第二条排队消息");
    expect(call.task).toContain("第三条排队消息");
    expect(harness.appendMailboxMessage).toHaveBeenCalledTimes(2);
    expect(harness.appendMailboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      mailboxMessage: expect.objectContaining({ messageId: "user-followup-2" }),
    }));
    expect(harness.appendMailboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      mailboxMessage: expect.objectContaining({ messageId: "user-followup-3" }),
    }));
    expect(harness.stored.get("user-followup-1")?.status).toBe("acked");
    expect(harness.stored.get("user-followup-2")?.status).toBe("acked");
    expect(harness.stored.get("user-followup-3")?.status).toBe("acked");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.invoke.mock.calls.length).toBe(1);
  });

  it("forwards every distinct targeted recipient in one sweep", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "targeted-1", inputType: "agent_message", text: "给 A", seq: 1, targetThreadKey: "child:child-a" }),
      mailboxMessage({ messageId: "targeted-2", inputType: "agent_message", text: "给 B", seq: 2, targetThreadKey: "child:child-b" }),
      mailboxMessage({ messageId: "targeted-3", inputType: "agent_message", text: "再给 A", seq: 3, targetThreadKey: "child:child-a" }),
    ]);

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.threadGateThreads.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 子分支行全部转投线程闸门（§10.4 第六/七轮：转发只看分支）。
    expect(harness.threadGateThreads).toContain("child:child-a");
    expect(harness.threadGateThreads).toContain("child:child-b");
    // 同一分支（child-a 两条）经触发去重合并；drain 期间的 dirty 最多补查一次闸门。
    const aWakes = harness.threadGateThreads.filter((thread) => thread === "child:child-a");
    expect(aWakes.length).toBeLessThanOrEqual(2);
    // 子分支行不进主智能体的消化 run。
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it("delivers user messages and notifications to the main agent in one run", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "bgnotify-task-1", inputType: "system_notification", text: "<task-notification><task-id>task-1</task-id></task-notification>", seq: 1 }),
      mailboxMessage({ messageId: "user-followup-1", inputType: "user_message", text: "排队的用户消息", seq: 2 }),
    ]);

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await waitFor(() => harness.acked.length === 2);

    // 无类别优先级：主智能体的信件一批交付——用户消息与通知进同一个 run。
    const call = harness.invoke.mock.calls[0]![0] as Record<string, any>;
    expect(call.executionKind).toBe("session_followup");
    expect(call.task).toContain("<task-id>task-1</task-id>");
    expect(call.task).toContain("排队的用户消息");
    expect(call.rootMailboxMessage).toEqual(expect.objectContaining({ id: "bgnotify-task-1" }));
    expect(harness.appendMailboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      mailboxMessage: expect.objectContaining({ messageId: "user-followup-1" }),
    }));
    expect(harness.stored.get("bgnotify-task-1")?.status).toBe("acked");
    expect(harness.stored.get("user-followup-1")?.status).toBe("acked");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.invoke.mock.calls.length).toBe(1);
  });

  it("produces a queued goal_continuation row and consumes it as the run's initial message", async () => {
    const harness = createHarness([], { goal: activeGoal(2) });

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await waitFor(() => harness.stored.get("goalcont_goal-1_2")?.status === "acked");

    // 生产者：预算门控（claimContinuation）通过后投递确定性 id 的等待行。
    expect(harness.goalStore.claimContinuation).toHaveBeenCalledTimes(1);
    expect(harness.mailbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "goalcont_goal-1_2",
      tenantId: "tenant-1",
      sessionId: "session-1",
      targetThreadKey: "root",
      kind: "request",
      inputType: "goal_continuation",
      sourceKind: "system",
      visibleToUser: false,
      metadata: { source: "goal_continuation", goal_id: "goal-1", goal_generation: 2 },
    }));
    // 投递成功即释放认领：预算已计、工作由持久行承载，run 不再持有 goal 锁。
    expect(harness.releaseContinuation).toHaveBeenCalledTimes(1);

    const call = harness.invoke.mock.calls[0]![0] as Record<string, any>;
    expect(call.executionKind).toBe("system.goal_continuation");
    expect(call.requestId).toBe("goal_continue_goalcont_goal-1_2");
    expect(call.task).toContain("<goal-continuation");
    // 引用行消费：goalcont 行自身就是初始消息，一次续跑一行，不再合成第二条行。
    expect(call.rootMailboxMessage).toEqual(expect.objectContaining({
      id: "goalcont_goal-1_2",
      inputType: "goal_continuation",
      sourceKind: "system",
    }));
    expect(call.persistUserMessage).toBeUndefined();
    expect(harness.stored.get("goalcont_goal-1_2")?.status).toBe("acked");
  });

  it("skips producing a second goal row while one is already queued", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "goalcont_goal-1_2", inputType: "goal_continuation", text: "<goal-continuation goal-id=\"goal-1\">已排队</goal-continuation>", seq: 1 }),
    ], { goal: activeGoal(2) });

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await waitFor(() => harness.stored.get("goalcont_goal-1_2")?.status === "acked");

    expect(harness.goalStore.claimContinuation).not.toHaveBeenCalled();
    expect(harness.mailbox.enqueue).not.toHaveBeenCalled();
    const call = harness.invoke.mock.calls[0]![0] as Record<string, any>;
    expect(call.executionKind).toBe("system.goal_continuation");
    expect(harness.stored.get("goalcont_goal-1_2")?.status).toBe("acked");
  });

  it("settles a queued goal row without launching when the goal is no longer active", async () => {
    const pausedGoal = { ...activeGoal(2), status: "paused" };
    const harness = createHarness([
      mailboxMessage({ messageId: "goalcont_goal-1_2", inputType: "goal_continuation", text: "<goal-continuation goal-id=\"goal-1\">已排队</goal-continuation>", seq: 1 }),
    ], { goal: pausedGoal });

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.stored.get("goalcont_goal-1_2")?.status === "acked");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.invoke).not.toHaveBeenCalled();
    expect(harness.goalStore.setContinuationReason).toHaveBeenCalledWith("session-1", "goal-1", "manual_paused");
  });

  it("releases claimed notifications with a backoff when the run fails to start", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "bgnotify-task-1", inputType: "system_notification", text: "<task-notification><task-id>task-1</task-id></task-notification>", seq: 1 }),
    ]);
    harness.invoke.mockImplementation(() => {
      throw new Error("invoke failed");
    });

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.mailbox.claim.mock.calls.length === 1);
    await waitFor(() => harness.stored.get("bgnotify-task-1")?.status === "queued");

    // 失败释放带指数退避：available_at 后移，与 claim 死信上限共同保证重投有界。
    expect(harness.mailbox.release).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "bgnotify-task-1",
      availableAt: expect.any(String),
      lastError: "invoke failed",
    }));
    expect(harness.acked).toEqual([]);
  });

  it("still forwards child-branch rows when the main agent is busy", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "targeted-1", inputType: "agent_message", text: "给子分支", seq: 1, targetThreadKey: "child:child-a" }),
    ]);
    // root run 运行中：主分支闸门早退，但子分支交付不受阻（bgnotify 路由发起者后
    // root 繁忙不能阻塞子分支通知，否则滞留无上界）。
    harness.statusTracker.getStatusBySession.mockReturnValue({ status: "running", run_id: "run-root", task_id: null });
    harness.launchers.triggerBgNotificationRun("session-1");

    await waitFor(() => harness.threadGateThreads.length >= 1);
    expect(harness.threadGateThreads).toContain("child:child-a");
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it("releases the whole batch immediately when a user run wins the gate race", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "bgnotify-task-1", inputType: "system_notification", text: "<task-notification><task-id>task-1</task-id></task-notification>", seq: 1 }),
      mailboxMessage({ messageId: "bgnotify-task-2", inputType: "system_notification", text: "<task-notification><task-id>task-2</task-id></task-notification>", seq: 2 }),
    ]);
    harness.invoke.mockImplementation(() => ({
      promise: Promise.resolve({ success: true, content: "" }),
      // 用户 run 抢先登台（followup disposition）：整批行退回队列，由活动 run 的
      // refresh 按分支认领，不等认领租约过期。
      durableStarted: Promise.resolve({ kind: "followup", runId: "run-user", activeRunId: "run-user", queueAccepted: true }),
    }));

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await waitFor(() => harness.mailbox.release.mock.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 整批放回且无退避：available_at 即时（指数退避首档为 +5s），不带 lastError。
    for (const [input] of harness.mailbox.release.mock.calls as Array<[Record<string, any>]>) {
      expect(Math.abs(Date.parse(input.availableAt) - Date.now())).toBeLessThan(2_000);
      expect(input.lastError).toBeUndefined();
    }
    // 头行不经闸门 settle、伴随行不物化——全部回到 queued 等待活动 run 认领。
    expect(harness.appendMailboxMessage).not.toHaveBeenCalled();
    expect(harness.acked).toEqual([]);
    expect(harness.stored.get("bgnotify-task-1")?.status).toBe("queued");
    expect(harness.stored.get("bgnotify-task-2")?.status).toBe("queued");
    expect(harness.invoke.mock.calls.length).toBe(1);
  });

  it("skips goal production when the queued goal row falls outside the listPending window", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "goalcont_goal-1_2", inputType: "goal_continuation", text: "<goal-continuation goal-id=\"goal-1\">已排队</goal-continuation>", seq: 1 }),
    ], { goal: activeGoal(2) });
    // 模拟 root 积压超窗：FIFO 头 100 条不含 goal 行，全量 existsPending 仍能看到。
    const originalListPending = harness.mailbox.listPending.getMockImplementation()!;
    harness.mailbox.listPending.mockImplementation(async (input?: unknown) => {
      const rows = await (originalListPending as (input?: unknown) => Promise<never[]>)(input);
      return rows.filter((row) => (row as { input_type?: string }).input_type !== "goal_continuation");
    });
    const existsPending = vi.fn(async () => true);
    (harness.mailbox as Record<string, unknown>).existsPending = existsPending;

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await waitFor(() => harness.stored.get("goalcont_goal-1_2")?.status === "acked");

    // 窗口外仍不重复生产：不 claim 新一代、不投递第二条 goal 行（认领口径全量可见）。
    expect(existsPending).toHaveBeenCalledWith(expect.objectContaining({
      inputType: "goal_continuation",
      targetThreadKey: "root",
    }));
    expect(harness.goalStore.claimContinuation).not.toHaveBeenCalled();
    expect(harness.mailbox.enqueue).not.toHaveBeenCalled();
  });

  it("merges an idle trigger that arrives mid-sweep into a re-sweep", async () => {
    const harness = createHarness([], { goal: null });
    let listPendingCalls = 0;
    const originalListPending = harness.mailbox.listPending.getMockImplementation()!;
    harness.mailbox.listPending.mockImplementation(async (input?: unknown) => {
      listPendingCalls += 1;
      if (listPendingCalls === 1) {
        // 第一轮扫描进行中，新触发到达——dirty 合并，扫描结束后补跑一轮。
        harness.launchers.triggerBgNotificationRun("session-1");
      }
      return (originalListPending as (input?: unknown) => Promise<never[]>)(input);
    });

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => listPendingCalls >= 2, 1_500);
  });
});
