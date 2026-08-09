import { describe, expect, it, vi } from "vitest";

import { createLaunchers } from "../src/services/agent/execution/launchers.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

const worker = { agent_name: "worker", display_name: "Worker", enabled: true };
const parent = { agent_name: "parent", display_name: "Parent", enabled: true };

describe("Agent mailbox continuation result recovery", () => {
  it("rebuilds one missing terminal result from the durable continuation Run", async () => {
    const harness = createRecoveryHarness();

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.enqueue.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.launchers.triggerBgNotificationRun("session-1");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.enqueue).toHaveBeenCalledTimes(1);
    expect(harness.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "continuation-run:terminal_result",
      targetRunId: "parent-run",
      replyToMessageId: "source-request",
      correlationId: "corr-1",
      contentParts: [{ type: "text", text: "recovered result" }],
    }));
  });

  it("scans beyond the first 500 durable Runs", async () => {
    const irrelevantRuns = Array.from({ length: 500 }, (_, index) => ({
      run_id: `unrelated-${index}`,
      entrypoint: "agent_stream",
    }));
    let continuationRun: Record<string, unknown> | null = null;
    const listRuns = vi.fn(async (_sessionId: string, _limit = 500, offset = 0) => ({
      items: offset === 0 ? irrelevantRuns : continuationRun ? [continuationRun] : [],
      total: 501,
    }));
    const harness = createRecoveryHarness({ listRuns });
    continuationRun = harness.continuationRun;

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.enqueue.mock.calls.length === 1);

    expect(listRuns).toHaveBeenNthCalledWith(1, "session-1", 500, 0);
    expect(listRuns).toHaveBeenNthCalledWith(2, "session-1", 500, 500);
  });

  it.each(["queued", "claimed"])(
    "settles a %s continuation source before rebuilding its terminal result",
    async (sourceStatus) => {
      const harness = createRecoveryHarness({ sourceStatus });

      harness.launchers.triggerBgNotificationRun("session-1");
      await waitFor(() => harness.enqueue.mock.calls.length === 1);

      expect(harness.settle).toHaveBeenCalledWith({
        sessionId: "session-1",
        messageId: "source-request",
      });
      expect(harness.stored.get("source-request")?.status).toBe("acked");
    },
  );

  it.each([
    ["failed", "provider_error", "provider_error"],
    ["interrupted", "session_stopped", "用户主动停止运行"],
  ] as const)(
    "recovers a %s continuation without a final message from its terminal reason",
    async (status, terminalReason, expectedContent) => {
      const harness = createRecoveryHarness({
        run: {
          status,
          terminal_reason: terminalReason,
          final_message_id: null,
        },
      });

      harness.launchers.triggerBgNotificationRun("session-1");
      await waitFor(() => harness.enqueue.mock.calls.length === 1);

      expect(harness.getMessageById).not.toHaveBeenCalled();
      expect(harness.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        messageId: "continuation-run:terminal_result",
        contentParts: [{ type: "text", text: expectedContent }],
        metadata: expect.objectContaining({ status: "failed", success: false }),
      }));
    },
  );

  it("recovers a completed continuation whose final message projection is missing", async () => {
    const harness = createRecoveryHarness({
      run: { final_message_id: null },
    });

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.enqueue.mock.calls.length === 1);

    expect(harness.getMessageById).not.toHaveBeenCalled();
    expect(harness.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      contentParts: [{ type: "text", text: "子 Agent 已完成消息处理" }],
      metadata: expect.objectContaining({ status: "completed", success: true }),
    }));
  });
});

function createRecoveryHarness(input: {
  run?: Record<string, unknown>;
  sourceStatus?: string;
  listRuns?: ReturnType<typeof vi.fn>;
} = {}) {
  const session = {
    session_id: "session-1",
    tenant_id: "tenant-1",
    owner_user_id: null,
    visibility: "private",
    origin_type: "direct",
    origin_id: null,
    origin_channel: "api",
    workspace_id: null,
    team_snapshot: createTestTeamSnapshot("parent", [parent, worker] as never),
    permission_mode: null,
    metadata: {},
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
  const continuationRun = {
    run_id: "continuation-run",
    session_id: "session-1",
    tenant_id: "tenant-1",
    entrypoint: "system.agent_message",
    status: "completed",
    task_summary: null,
    terminal_reason: null,
    request_id: "agent_result:source-request",
    user_id: null,
    agent_name: "worker",
    agent_call_id: "continuation-call",
    lineage_parent_call_id: "parent-call",
    agent_display_name: "Worker",
    lease_root_run_id: "continuation-run",
    thread_key: "child:child-1",
    parent_run_id: "parent-run",
    parent_call_id: "parent-tool-call",
    child_agent_id: "child-1",
    final_message_id: "continuation-final",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...(input.run ?? {}),
  };
  const parentRun = {
    ...continuationRun,
    run_id: "parent-run",
    entrypoint: "agent_stream",
    agent_name: "parent",
    agent_call_id: "parent-call",
    agent_display_name: "Parent",
    lease_root_run_id: "parent-run",
    thread_key: "root",
    parent_run_id: null,
    parent_call_id: null,
    child_agent_id: null,
    final_message_id: "parent-final",
  };
  const stored = new Map<string, any>([["source-request", {
    message_id: "source-request",
    status: input.sourceStatus ?? "acked",
    correlation_id: "corr-1",
  }]]);
  const settle = vi.fn(async ({ messageId }: { sessionId: string; messageId: string }) => {
    const message = stored.get(messageId);
    if (!message || !["queued", "claimed", "acked", "expired"].includes(message.status)) return false;
    if (message.status === "queued" || message.status === "claimed") message.status = "acked";
    return true;
  });
  const enqueue = vi.fn(async (enqueueInput: Record<string, any>) => {
    const message = {
      message_id: enqueueInput.messageId,
      status: "queued",
      correlation_id: enqueueInput.correlationId,
      target_run_id: enqueueInput.targetRunId,
      target_agent_call_id: enqueueInput.targetAgentCallId,
      target_thread_key: enqueueInput.targetThreadKey,
      target_child_agent_id: enqueueInput.targetChildAgentId,
      metadata: enqueueInput.metadata,
    };
    stored.set(message.message_id, message);
    return message;
  });
  const listRuns = input.listRuns ?? vi.fn(async () => ({ items: [continuationRun], total: 1 }));
  const getMessageById = vi.fn(async () => ({
    content: "recovered result",
    content_parts: [{ type: "text", text: "recovered result" }],
  }));
  const launchers = createLaunchers({
    tenantId: "tenant-1" as never,
    sessions: { getSession: vi.fn(async () => session) } as never,
    runtimeCore: {} as never,
    slashCommandHandler: {} as never,
    attachmentResolver: {} as never,
    statusTracker: { getStatusBySession: vi.fn(() => ({ status: "running" })) } as never,
    eventPublisher: {} as never,
    runEngine: {} as never,
    invocationService: {} as never,
    notificationQueue: {} as never,
    backgroundTasks: null,
    goalStore: null,
    runtimeStorage: { operations: {} } as never,
    clientEvents: {} as never,
    mailbox: {
      get: vi.fn(async (_sessionId: string, messageId: string) => stored.get(messageId) ?? null),
      enqueue,
      settle,
    } as never,
    runReader: {
      listRuns,
      getRun: vi.fn(async (_sessionId: string, runId: string) => runId === "parent-run" ? parentRun : null),
      getMessageById,
    } as never,
    participantRuns: { registerParticipantRun: vi.fn(), releaseParticipantRun: vi.fn() },
  });
  return { launchers, continuationRun, stored, settle, enqueue, listRuns, getMessageById };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}
