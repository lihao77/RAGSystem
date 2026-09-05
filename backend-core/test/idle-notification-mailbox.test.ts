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
  inputType: "user_message" | "system_notification";
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
    source_kind: input.inputType === "user_message" ? "user" : "system",
    visible_to_user: input.inputType === "user_message",
    sent_at: createdAt,
    correlation_id: null,
    reply_to_message_id: null,
    content_parts: [{ type: "text", text: input.text }],
    metadata: input.inputType === "user_message" ? {} : { source: "background_notification" },
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

function createHarness(messages: Array<ReturnType<typeof mailboxMessage>>) {
  const stored = new Map(messages.map((message) => [message.message_id, { ...message }]));
  const invoke = vi.fn((_input: Record<string, unknown>) => ({
    promise: Promise.resolve({ success: true, content: "" }),
    durableStarted: Promise.resolve({ kind: "started", runId: "run-1" }),
  }));
  const acked: string[] = [];
  const mailbox = {
    get: vi.fn(async (_sessionId: string, messageId: string) => stored.get(messageId) ?? null),
    enqueue: vi.fn(async () => { throw new Error("unexpected enqueue"); }),
    listPending: vi.fn(async () => Array.from(stored.values()).filter((message) => message.status === "queued")),
    claim: vi.fn(async () => {
      // 与真实 idle 谓词一致（agent-mailbox-ops claimSync）：root 线程且无定向 run。
      const claimable = Array.from(stored.values()).filter((message) => message.status === "queued"
        && message.target_run_id == null && message.target_thread_key === "root");
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
    settle: vi.fn(async () => true),
  };
  const scheduleAutoTrigger = vi.fn();
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
    statusTracker: { getStatusBySession: vi.fn(() => null) } as never,
    eventPublisher: {} as never,
    runEngine: {} as never,
    invocationService: { invoke } as never,
    backgroundTasks: {
      hasRunningTasksDurable: vi.fn(async () => false),
      scheduleAutoTrigger,
    } as never,
    goalStore: null,
    runtimeStorage: { operations: {} } as never,
    clientEvents: {} as never,
    mailbox: mailbox as never,
    runReader: {
      getRun: vi.fn(async () => null),
      listRuns: vi.fn(async () => ({ items: [], total: 0 })),
      getMessageById: vi.fn(async () => null),
    } as never,
    participantRuns: { registerParticipantRun: vi.fn(), releaseParticipantRun: vi.fn() },
  });
  return { launchers, invoke, mailbox, stored, acked, scheduleAutoTrigger };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("idle background notification consumption from the session mailbox", () => {
  it("starts a system.bg_notification run from queued notifications and acks them", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "bgnotify-task-1", inputType: "system_notification", text: "<task-notification><task-id>task-1</task-id></task-notification>", seq: 1 }),
      mailboxMessage({ messageId: "bgnotify-task-2", inputType: "system_notification", text: "<task-notification><task-id>task-2</task-id></task-notification>", seq: 2 }),
    ]);

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await waitFor(() => harness.acked.length === 2);

    const call = harness.invoke.mock.calls[0]![0] as Record<string, any>;
    expect(call.executionKind).toBe("system.bg_notification");
    expect(call.requestId).toMatch(/^bg_notify_/);
    expect(call.task).toContain("<task-id>task-1</task-id>");
    expect(call.task).toContain("<task-id>task-2</task-id>");
    expect(call.persistUserMessage).toEqual(expect.objectContaining({
      inputType: "system_notification",
      sourceKind: "system",
      visibleToUser: false,
      metadata: { source: "background_notification" },
    }));
    expect(harness.stored.get("bgnotify-task-1")?.status).toBe("acked");
    expect(harness.stored.get("bgnotify-task-2")?.status).toBe("acked");
  });

  it("prefers a queued user followup even when notifications arrived first", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "bgnotify-task-1", inputType: "system_notification", text: "<task-notification><task-id>task-1</task-id></task-notification>", seq: 1 }),
      mailboxMessage({ messageId: "user-followup-1", inputType: "user_message", text: "排队的用户消息", seq: 2 }),
    ]);

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const call = harness.invoke.mock.calls[0]![0] as Record<string, any>;
    expect(call.executionKind).toBe("session_followup");
    expect(call.requestId).toBe("session_followup_user-followup-1");
    expect(call.rootMailboxMessage).toEqual(expect.objectContaining({ id: "user-followup-1" }));
    // 通知未被动过：留给用户消息补跑完成后的下一次 idle 检查。
    expect(harness.mailbox.claim).not.toHaveBeenCalled();
    expect(harness.stored.get("bgnotify-task-1")?.status).toBe("queued");
  });

  it("releases a user message that races into the idle claim back to queued", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "bgnotify-task-1", inputType: "system_notification", text: "<task-notification><task-id>task-1</task-id></task-notification>", seq: 1 }),
    ]);
    const racingUser = mailboxMessage({ messageId: "user-race", inputType: "user_message", text: "插队消息", seq: 2 });
    harness.stored.set("user-race", racingUser);
    // 真实竞态：listPending 之后、claim 之前到达的用户消息被 idle 谓词一并领走。
    harness.mailbox.listPending.mockImplementation(async () => [harness.stored.get("bgnotify-task-1")!]);

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.invoke.mock.calls.length === 1);
    await waitFor(() => harness.acked.length === 1);

    const call = harness.invoke.mock.calls[0]![0] as Record<string, any>;
    expect(call.executionKind).toBe("system.bg_notification");
    expect(call.task).toContain("<task-id>task-1</task-id>");
    expect(call.task).not.toContain("插队消息");
    expect(harness.stored.get("bgnotify-task-1")?.status).toBe("acked");
    // 被误领的用户消息 release 回队，留给下一次 idle 检查走 session_followup 补跑。
    expect(harness.stored.get("user-race")?.status).toBe("queued");
    expect(harness.mailbox.release).toHaveBeenCalledWith(expect.objectContaining({ messageId: "user-race" }));
  });

  it("releases claimed notifications back to queued when the run fails to start", async () => {
    const harness = createHarness([
      mailboxMessage({ messageId: "bgnotify-task-1", inputType: "system_notification", text: "<task-notification><task-id>task-1</task-id></task-notification>", seq: 1 }),
    ]);
    harness.invoke.mockImplementation(() => {
      throw new Error("invoke failed");
    });

    harness.launchers.triggerBgNotificationRun("session-1");
    await waitFor(() => harness.mailbox.claim.mock.calls.length === 1);
    await waitFor(() => harness.stored.get("bgnotify-task-1")?.status === "queued");

    expect(harness.invoke).toThrow();
    expect(harness.acked).toEqual([]);
  });
});
