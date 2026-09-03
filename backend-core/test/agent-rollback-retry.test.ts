import { describe, expect, it, vi } from "vitest";

import type { MessageInfo } from "../src/contracts/session/session.js";
import { createLaunchers } from "../src/services/agent/execution/launchers.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

function message(overrides: Partial<MessageInfo>): MessageInfo {
  return {
    id: "message-1",
    seq: 1,
    session_id: "session-1",
    role: "user",
    content_parts: [{ type: "text", text: "task" }],
    metadata: {},
    created_at: new Date(0).toISOString(),
    thread_key: "root",
    child_agent_id: null,
    ...overrides,
  };
}

function createTestLaunchers(retryMessage: MessageInfo) {
  const rollbackMessages = vi.fn();
  const launchers = createLaunchers({
    tenantId: "tenant-1" as never,
    sessions: {
      getMessageForRetry: vi.fn(async () => retryMessage),
      rollbackMessages,
    } as never,
    runtimeCore: {} as never,
    slashCommandHandler: {} as never,
    attachmentResolver: {} as never,
    statusTracker: { getStatusBySession: vi.fn(() => null) } as never,
    eventPublisher: {} as never,
    runEngine: {} as never,
    invocationService: {} as never,
    notificationQueue: {} as never,
    backgroundTasks: null,
    goalStore: null,
    runtimeStorage: { operations: { getActiveRootRun: vi.fn(async () => null) } } as never,
    clientEvents: {} as never,
    participantRuns: {} as never,
  });
  return { launchers, rollbackMessages };
}

/** 维护租约 kind 用例：claim 成功后用 renew=false 让流程在 sendUserMessage 前早退，
 * 只断言 claim 入参，不必 mock 完整发送链。 */
function createLeaseKindLaunchers(retryMessage: MessageInfo) {
  const claimSessionMaintenance = vi.fn(async () => ({ claimed: true, activeRunId: null }));
  const launchers = createLaunchers({
    tenantId: "tenant-1" as never,
    sessions: {
      getMessageForRetry: vi.fn(async () => retryMessage),
      rollbackMessages: vi.fn(async () => 1),
    } as never,
    runtimeCore: {} as never,
    slashCommandHandler: {} as never,
    attachmentResolver: {} as never,
    statusTracker: { getStatusBySession: vi.fn(() => null) } as never,
    eventPublisher: {} as never,
    runEngine: {} as never,
    invocationService: {} as never,
    notificationQueue: {} as never,
    backgroundTasks: null,
    goalStore: null,
    runtimeStorage: {
      operations: {
        getActiveRootRun: vi.fn(async () => null),
        claimSessionMaintenance,
        renewSessionMaintenance: vi.fn(async () => false),
        releaseSessionMaintenance: vi.fn(async () => undefined),
      },
    } as never,
    clientEvents: { publish: vi.fn(async () => undefined) } as never,
    participantRuns: {} as never,
  });
  return { launchers, claimSessionMaintenance };
}

describe("rollback maintenance lease kind", () => {
  it.each([
    ["原样重试 /compact", "/compact", undefined, "compact"],
    ["编辑重发为 /compact", "别的", "/compact", "compact"],
    ["普通任务重试", "正常任务", undefined, "rollback"],
  ])("%s 时租约 kind 按实际操作标记", async (_label, taskText, modifyUserMessage, expectedKind) => {
    const { launchers, claimSessionMaintenance } = createLeaseKindLaunchers(
      message({ content_parts: [{ type: "text", text: taskText }] }),
    );

    await launchers.startRollbackRetry({
      sessionId: "session-1",
      userId: "user-1",
      requestId: "request-1",
      afterMessageId: "message-1",
      ...(modifyUserMessage ? { modifyUserMessage } : {}),
    });

    // 租约 kind 是前端刷新恢复的事实源（maintenance·compact → 压缩横线/呼吸点派生）：
    // 回滚入口执行 /compact 时必须标 compact，普通重试仍标 rollback。
    expect(claimSessionMaintenance).toHaveBeenCalledWith(expect.objectContaining({ kind: expectedKind }));
  });
});

describe("Agent rollback/retry authorization", () => {
  it.each([
    ["child task", message({ thread_key: "child:one", child_agent_id: "child-1" })],
    ["Agent message", message({ metadata: { agent_message: true } })],
    ["hidden internal message", message({ metadata: { hidden: true } })],
  ])("rejects a %s before deleting session history", async (_label, retryMessage) => {
    const { launchers, rollbackMessages } = createTestLaunchers(retryMessage);

    const result = await launchers.startRollbackRetry({
      sessionId: "session-1",
      userId: "user-1",
      requestId: "request-1",
      afterMessageId: retryMessage.id,
    });

    expect(result).toEqual(expect.objectContaining({
      started: false,
      deleted: 0,
      error: "只能从根会话中的用户消息重试",
    }));
    expect(rollbackMessages).not.toHaveBeenCalled();
  });
});

describe("rollback 命令失败文案透传", () => {
  it("回滚入口 /compact 被用户停止时，把 command_result 文案作为 error 带给路由层", async () => {
    const stoppedContent = "压缩已停止，历史保持原样";
    const slashHandle = vi.fn(async () => ({
      kind: "command" as const,
      start: { started: false, session_id: "session-1", kind: "command" as const },
      success: false,
      content: stoppedContent,
      contentParts: [],
    }));
    const retryMessage = message({ content_parts: [{ type: "text", text: "/compact" }] });
    const launchers = createLaunchers({
      tenantId: "tenant-1" as never,
      sessions: {
        getSession: vi.fn(async () => ({
          session_id: "session-1",
          owner_user_id: "user-1",
          visibility: "private",
          origin_type: "direct",
          origin_id: null,
          origin_channel: "web",
          workspace_id: null,
          team_snapshot: createTestTeamSnapshot(),
          metadata: {},
          permission_mode: null,
        })),
        getMessageForRetry: vi.fn(async () => retryMessage),
        rollbackMessages: vi.fn(async () => 1),
        addMessage: vi.fn(async (input: Record<string, unknown>) => ({
          id: "message-new",
          ...input,
          content_parts: input.contentParts,
        })),
      } as never,
      runtimeCore: {} as never,
      slashCommandHandler: { handle: slashHandle } as never,
      attachmentResolver: {} as never,
      statusTracker: { getStatusBySession: vi.fn(() => null) } as never,
      eventPublisher: {} as never,
      runEngine: {} as never,
      invocationService: {} as never,
      notificationQueue: {} as never,
      backgroundTasks: null,
      goalStore: null,
      runtimeStorage: {
        operations: {
          getActiveRootRun: vi.fn(async () => null),
          claimSessionMaintenance: vi.fn(async () => ({ claimed: true, activeRunId: null })),
          renewSessionMaintenance: vi.fn(async () => true),
          releaseSessionMaintenance: vi.fn(async () => undefined),
        },
      } as never,
      clientEvents: { publish: vi.fn(async () => undefined) } as never,
      participantRuns: {} as never,
    });

    const result = await launchers.startRollbackRetry({
      sessionId: "session-1",
      userId: "user-1",
      requestId: "request-1",
      afterMessageId: "message-1",
    });

    // 无 error 字段时路由 400 会兜底成"重试启动失败"，前端 toast 与消息流文案对不上。
    expect(result.started).toBe(false);
    expect(result).toMatchObject({ error: stoppedContent, command_result: { success: false, content: stoppedContent } });
  });
});
