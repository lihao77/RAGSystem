import { describe, expect, it, vi } from "vitest";

import { AsyncKernelEventPersister } from "../src/services/agent/sdk/async-event-persister.js";
import type { AsyncPersisterRunContext } from "../src/services/agent/sdk/async-event-persister.js";
import type { RuntimeStorage } from "../src/contracts/storage/runtime-storage.js";
import type { ClientEventPublisherPort } from "../src/contracts/runtime/core-runtime-ports.js";
import type { SessionIdentity } from "../src/contracts/session/session.js";

const sessionIdentity = {
  sessionId: "session-1",
  ownerUserId: null,
  visibility: "private" as const,
  originType: "direct" as const,
  originId: null,
  originChannel: "api" as const,
  workspaceId: null,
  teamSnapshot: {},
  metadata: {},
  permissionMode: null,
} as SessionIdentity;

function baseCtx(overrides: Partial<AsyncPersisterRunContext> = {}): AsyncPersisterRunContext {
  return {
    tenantId: "tenant-1" as AsyncPersisterRunContext["tenantId"],
    sessionId: "session-1",
    runId: "child-run-1",
    threadKey: "child:child-1",
    agentName: "worker",
    agentDisplayName: "Worker",
    rootCallId: "call_child_1",
    sessionIdentity,
    parentRunId: "parent-run-1",
    childAgentId: "child-1",
    ...overrides,
  } as AsyncPersisterRunContext;
}

function createHarness(ctx: AsyncPersisterRunContext) {
  const startRun = vi.fn(async (_input: { initialRecords?: unknown[] }) => ({ run: null, records: [] }));
  const startOrAppendRoot = vi.fn(async () => ({ kind: "started" as const, records: [] }));
  const storage = {
    tenantId: ctx.tenantId,
    operations: { startRun, startOrAppendRoot },
  } as unknown as RuntimeStorage;
  const prepared: Array<{ eventId: string; envelope: Record<string, unknown> }> = [];
  const clientEvents = {
    prepare: vi.fn((_sessionId: string, envelope: never, meta: { eventId: string }) => {
      prepared.push({ eventId: meta.eventId, envelope: envelope as unknown as Record<string, unknown> });
      return { eventId: meta.eventId, envelope };
    }),
    deliver: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
  } as unknown as Pick<ClientEventPublisherPort, "prepare" | "deliver" | "flush">;
  const persister = new AsyncKernelEventPersister(storage, clientEvents, ctx, null);
  return { persister, startRun, startOrAppendRoot, prepared };
}

function initialMessage(metadata: Record<string, unknown>) {
  return {
    messageId: "msg_initial_1",
    sessionId: "session-1",
    role: "user" as const,
    contentParts: [{ type: "text" as const, text: "[agent-message kind=request id=m1]\nhi child\n[/agent-message]" }],
    threadKey: "child:child-1",
    childAgentId: "child-1",
    metadata,
  };
}

describe("AsyncKernelEventPersister 初始 agent_message 事件", () => {
  it("child run 携带 agent_message 初始消息时补发 agent_message 初始 Envelope", async () => {
    const ctx = baseCtx({
      initialMessage: initialMessage({
        agent_message: true,
        agent_message_display_content: "hi child",
        direction: "parent_to_child",
        source_agent_name: "parent",
        mailbox_kind: "request",
        consumed_by_run_id: "child-run-1",
      }),
    });
    const { persister, startRun, prepared } = createHarness(ctx);

    await persister.startRun();

    expect(startRun).toHaveBeenCalledTimes(1);
    const initialRecords = startRun.mock.calls[0]?.[0].initialRecords ?? [];
    const envelopes = prepared.filter((record) => record.eventId.endsWith(":agent_message"));
    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0]!.envelope as {
      type: string;
      run_id: string;
      message_id: string;
      boundary_message_id?: string;
      payload: Record<string, unknown> & { metadata: Record<string, unknown> };
    };
    expect(initialRecords).toHaveLength(envelopes.length);
    expect(envelope.type).toBe("agent_message");
    expect(envelope.run_id).toBe("child-run-1");
    expect(envelope.message_id).toBe("msg_initial_1");
    expect(envelope.boundary_message_id).toBe("msg_initial_1");
    expect(envelope.payload.target_child_agent_id).toBe("child-1");
    expect(envelope.payload.target_thread_key).toBe("child:child-1");
    expect(envelope.payload.direction).toBe("parent_to_child");
    expect(envelope.payload.source_agent_name).toBe("parent");
    expect(envelope.payload.content).toBe("hi child");
    expect(envelope.payload.metadata.agent_message).toBe(true);
    expect(envelope.payload.metadata.consumed_by_run_id).toBe("child-run-1");
  });

  it("mailbox 续接（mailbox_message_id、无 agent_message 标记的用户插话）同样补发事件", async () => {
    const ctx = baseCtx({
      initialMessage: initialMessage({
        mailbox_message_id: "mbx-1",
        mailbox_kind: "request",
        visible_to_user: true,
        agent_message_display_content: "user interjection",
      }),
    });
    const { persister, prepared } = createHarness(ctx);

    await persister.startRun();

    const envelopes = prepared.filter((record) => record.eventId.endsWith(":agent_message"));
    expect(envelopes).toHaveLength(1);
    const payload = envelopes[0]!.envelope.payload as Record<string, unknown>;
    expect(payload.content).toBe("user interjection");
    expect((payload.metadata as Record<string, unknown>).agent_message).toBeUndefined();
  });

  it("委派任务的合成初始消息（无 agent/mailbox 标记）不产生 agent_message 事件", async () => {
    const ctx = baseCtx({
      initialMessage: initialMessage({
        agent: "worker",
        run_id: "child-run-1",
        source: "agent_call",
      }),
    });
    const { persister, prepared } = createHarness(ctx);

    await persister.startRun();

    expect(prepared.filter((record) => record.eventId.endsWith(":agent_message"))).toHaveLength(0);
  });

  it("委派任务的合成初始消息以 user message_saved 播报子线程输入边界", async () => {
    const ctx = baseCtx({
      initialEnvelopes: [{
        type: "agent_started",
        session_id: "session-1",
        run_id: "child-run-1",
        participant_id: "child-1",
        payload: { phase: "start", child_agent_id: "child-1" },
      } as never],
      initialMessage: {
        messageId: "msg_delegation_task",
        sessionId: "session-1",
        role: "user" as const,
        contentParts: [{ type: "text" as const, text: "统计近一周日均水位。" }],
        threadKey: "child:child-1",
        childAgentId: "child-1",
        metadata: {
          agent: "worker",
          run_id: "child-run-1",
          request_id: "req-child-1",
          execution_kind: "call_agent",
          source: "agent_call",
          child_agent_id: "child-1",
        },
      },
    });
    const { persister, prepared, startRun } = createHarness(ctx);

    await persister.startRun();

    // 子线程的一切（输入气泡、执行帧挂载点）都以这行为边界：它必须被播报，
    // 否则实时视图只剩最终答案，要等切换重载才补齐。
    const saved = prepared.filter((record) => record.eventId.endsWith(":initial:message_saved"));
    expect(saved).toHaveLength(1);
    const envelope = saved[0]!.envelope as {
      type: string;
      participant_id?: string;
      boundary_message_id?: string;
      payload: { category: string; ref: Record<string, unknown> };
    };
    expect(envelope.type).toBe("state_sync");
    expect(envelope.participant_id).toBe("child-1");
    expect(envelope.boundary_message_id).toBe("msg_delegation_task");
    expect(envelope.payload.category).toBe("message_saved");
    expect(envelope.payload.ref).toMatchObject({
      message_id: "msg_delegation_task",
      role: "user",
      request_id: "req-child-1",
      metadata: { run_id: "child-run-1", child_agent_id: "child-1" },
    });
    // 渲染口径不变：合成指令不冒充智能体气泡。
    expect(prepared.filter((record) => record.eventId.endsWith(":agent_message"))).toHaveLength(0);
    // 边界帧排在 run 锚点之前：前端先有锚点，再挂 agent_started 与后续执行帧。
    const initialTypes = (startRun.mock.calls[0]?.[0].initialRecords ?? [])
      .map((record) => (record as { envelope: { type: string } }).envelope.type);
    expect(initialTypes).toEqual(["state_sync", "agent_started"]);
  });

  it("mailbox 语义的子 run 初始消息不重复播报 user message_saved", async () => {
    const ctx = baseCtx({
      initialMessage: initialMessage({
        mailbox_message_id: "mbx-1",
        agent_message: true,
        consumed_by_run_id: "child-run-1",
      }),
    });
    const { persister, prepared } = createHarness(ctx);

    await persister.startRun();

    expect(prepared.filter((record) => record.eventId.endsWith(":initial:message_saved"))).toHaveLength(0);
    expect(prepared.filter((record) => record.eventId.endsWith(":agent_message"))).toHaveLength(1);
  });

  it("root run 的 message_saved 初始事件保持原状且不混入 agent_message", async () => {
    const ctx = baseCtx({
      parentRunId: null,
      childAgentId: null,
      runId: "root-run-1",
      threadKey: "root",
      rootMailboxMessage: {
        id: "mbx-root-1",
        inputType: "user_message",
        sourceKind: "user",
        visibleToUser: true,
        sentAt: new Date(0).toISOString(),
        contentParts: [{ type: "text", text: "hello" }],
        metadata: { request_id: "req-1" },
      },
    });
    const { persister, prepared } = createHarness(ctx);

    await persister.startRun();

    const types = prepared.map((record) => (record.envelope as { type: string }).type);
    expect(types).toContain("state_sync");
    expect(types).not.toContain("agent_message");
  });

  it("goal 续跑/后台通知的合成初始输入同样以 mailbox 行进入 startOrAppendRoot", async () => {
    // 钉住统一入口不变量：系统合成消息（goal 续跑、bg 通知）与用户首发一样，
    // root run 的初始输入在存储闸门处是 mailbox 消息（由 startOrAppendRoot 同事务
    // enqueue+settle）。regression 防的是有人把 persistUserMessage 路径改回直写。
    const ctx = baseCtx({
      parentRunId: null,
      childAgentId: null,
      runId: "root-run-goal",
      threadKey: "root",
      rootMailboxMessage: {
        id: "mbx-goal-1",
        inputType: "goal_continuation",
        sourceKind: "system",
        visibleToUser: false,
        sentAt: new Date(0).toISOString(),
        contentParts: [{ type: "text", text: "<goal-continuation goal-id=\"goal-1\">推进</goal-continuation>" }],
        metadata: { source: "goal_continuation", goal_id: "goal-1" },
      },
    });
    const { persister, startRun, startOrAppendRoot } = createHarness(ctx);

    await persister.startRun();

    expect(startRun).not.toHaveBeenCalled();
    expect(startOrAppendRoot).toHaveBeenCalledTimes(1);
    expect(startOrAppendRoot).toHaveBeenCalledWith(expect.objectContaining({
      mailboxMessage: expect.objectContaining({
        messageId: "mbx-goal-1",
        sessionId: "session-1",
        targetThreadKey: "root",
        kind: "request",
        inputType: "goal_continuation",
        sourceKind: "system",
        visibleToUser: false,
        metadata: expect.objectContaining({ source: "goal_continuation", goal_id: "goal-1" }),
      }),
      followupPolicy: "queue",
    }));
  });
});
