import { describe, expect, it, vi } from "vitest";

import type { MessageInfo } from "../src/contracts/session/session.js";
import { createLaunchers } from "../src/services/agent/execution/launchers.js";

function message(overrides: Partial<MessageInfo>): MessageInfo {
  return {
    id: "message-1",
    seq: 1,
    session_id: "session-1",
    role: "user",
    content: "task",
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
