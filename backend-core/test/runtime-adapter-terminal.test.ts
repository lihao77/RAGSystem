import { describe, expect, it, vi } from "vitest";
import { AgentConfigSchema, type AgentConfig } from "../src/contracts/agent/agent-config.js";
import { executeRunWithSdk, type SdkRuntimeAdapterDeps } from "../src/services/agent/sdk/runtime-adapter.js";
import type { MessageInfo, SessionIdentity } from "../src/contracts/session/session.js";
import type { AgentMailboxMessage, AgentMailboxStorePort } from "../src/contracts/storage/agent-mailbox-repository.js";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

const runtimeMock = vi.hoisted(() => ({
  createRuntime: vi.fn(),
}));

vi.mock("@ragsystem/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ragsystem/agent-sdk")>();
  return { ...actual, createRuntime: runtimeMock.createRuntime };
});

const agent = AgentConfigSchema.parse({
  agent_name: "test-agent",
  display_name: "Test Agent",
  llm_tiers: { default: { provider: "provider", model_name: "model" } },
});

const sessionIdentity: SessionIdentity = {
  sessionId: "session-1",
  ownerUserId: null,
  visibility: "private",
  originType: "direct",
  originId: null,
  originChannel: "api",
  workspaceId: null,
  teamSnapshot: createTestTeamSnapshot("test-agent", [agent]),
  metadata: {},
  permissionMode: null,
};

function input(overrides: Partial<Parameters<typeof executeRunWithSdk>[1]> = {}) {
  return {
    sessionId: "session-1",
    runId: "run-1",
    taskId: "task-1",
    requestId: "request-1",
    rootCallId: "call-1",
    agent,
    provider: {
      key: "provider",
      name: "provider",
      provider_type: "test",
      api_key: "test-key",
      models: ["model"],
      model_map: { chat: "model" },
    },
    modelName: "model",
    task: "run task",
    threadKey: "root",
    sessionIdentity,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function deps(
  finalize: ReturnType<typeof vi.fn>,
  startRun: ReturnType<typeof vi.fn>,
  persist: ReturnType<typeof vi.fn>,
): SdkRuntimeAdapterDeps {
  const session = {
    session_id: "session-1",
    team_snapshot: createTestTeamSnapshot("test-agent", [agent]),
    tenant_id: "tenant-1",
    owner_user_id: null,
    visibility: "private",
    origin_type: "direct",
    origin_id: null,
    origin_channel: "api",
    workspace_id: null,
    permission_mode: null,
    metadata: {},
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  } as const;
  return {
    storage: {
      tenantId: "tenant-1",
      conversation: {
        getSession: vi.fn(async () => session),
        getRecentMessages: vi.fn(() => []),
        updateSessionMetadata: vi.fn(async () => ({})),
      },
      providerContinuations: { getProviderContinuation: vi.fn(() => null) },
      createEventPersister: vi.fn(() => ({
        startRun,
        persist,
        finalize,
      })),
    },
    toolsDeps: {
      pendingInteractions: null,
      taskTools: null,
      getAgentDelegation: () => null,
    },
    taskTools: null,
    eventPublisher: {
      publishEnvelope: vi.fn(),
      publishDelegateCall: vi.fn(),
      publishAgentMessage: vi.fn(),
    },
    providers: [{
      key: "provider",
      name: "provider",
      provider_type: "test",
      api_key: "test-key",
      models: ["model"],
      model_map: { chat: "model" },
    }],
    dataRoot: "C:\\tmp",
    permissionPolicy: {
      prepareSession: vi.fn(async () => undefined),
      getEffectivePolicy: vi.fn(() => ({ mode: "default", skip_all_approvals: false })),
    },
    pathAccessPolicyFactory: () => ({ setAllowUnapprovedExternalPaths: vi.fn() }),
    pendingInteractions: { onRootFinalized: vi.fn(async () => undefined) },
    hostToolRegistry: { get: vi.fn(() => []) },
    delegationPending: {},
  } as unknown as SdkRuntimeAdapterDeps;
}

function mailboxMessage(overrides: Partial<AgentMailboxMessage> = {}): AgentMailboxMessage {
  return {
    seq: 1,
    message_id: "mailbox-1",
    tenant_id: "tenant-1",
    session_id: "session-1",
    source_run_id: "parent-run",
    source_agent_call_id: "parent-call",
    target_run_id: "run-1",
    target_agent_call_id: "call-1",
    target_thread_key: "child-thread",
    target_child_agent_id: "child-1",
    kind: "request",
    input_type: "agent_message",
    source_kind: "agent",
    visible_to_user: false,
    sent_at: null,
    correlation_id: "corr-1",
    reply_to_message_id: null,
    content_parts: [{ type: "text", text: "please continue" }],
    metadata: {},
    status: "claimed",
    attempt_count: 1,
    claim_id: "claim-1",
    claimed_by: "worker",
    claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
    available_at: new Date(0).toISOString(),
    expires_at: null,
    last_error: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    acked_at: null,
    ...overrides,
  };
}

describe("executeRunWithSdk terminal convergence", () => {
  it("在 round boundary claim mailbox、写入 child history 并在 invoke 成功后 ACK", async () => {
    runtimeMock.createRuntime.mockReset();
    let history: any[] = [];
    const mailbox: AgentMailboxStorePort = {
      claim: vi.fn(async () => [{
        seq: 1,
        message_id: "mailbox-1",
        tenant_id: "tenant-1",
        session_id: "session-1",
        source_run_id: "parent-run",
        source_agent_call_id: "parent-call",
        target_run_id: "run-1",
        target_agent_call_id: "call-1",
        target_thread_key: "child-thread",
        target_child_agent_id: "child-1",
        kind: "request",
        input_type: "agent_message",
        source_kind: "agent",
        visible_to_user: false,
        sent_at: null,
        correlation_id: "corr-1",
        reply_to_message_id: null,
        content_parts: [{ type: "text", text: "please continue" }],
        metadata: { priority: "high" },
        status: "claimed",
        attempt_count: 1,
        claim_id: "claim-1",
        claimed_by: "worker",
        claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
        available_at: new Date(0).toISOString(),
        expires_at: null,
        last_error: null,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        acked_at: null,
      }] as any),
      ack: vi.fn(async () => true),
      settle: vi.fn(async () => true),
      release: vi.fn(async () => true),
      enqueue: vi.fn(),
      get: vi.fn(async () => null),
      expire: vi.fn(async () => 0),
    };
    const finalize = vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] }));
    const startRun = vi.fn(async () => ({ kind: "started", run: {} }));
    const persist = vi.fn(async () => undefined);
    const base = deps(finalize, startRun, persist);
    base.storage.agentMailbox = mailbox;
    base.storage.conversation.getRecentMessages = vi.fn(async () => history);
    base.storage.conversation.getMessageById = vi.fn(async (_sessionId: string, messageId: string) => history.find((message) => message.id === messageId) ?? null);
    base.storage.conversation.addMessage = vi.fn(async (message) => {
      const created = {
        seq: 1,
        id: message.messageId ?? "mailbox-1",
        session_id: message.sessionId,
        role: message.role,
        content: message.content,
        content_parts: message.contentParts,
        metadata: message.metadata ?? {},
        thread_key: message.threadKey ?? "root",
        child_agent_id: message.childAgentId ?? null,
        created_at: new Date(0).toISOString(),
      };
      history = [created];
      return created;
    });
    runtimeMock.createRuntime.mockImplementation((options: any) => ({
      run: () => ({
        runId: "run-1",
        events: (async function* () {})(),
        result: (async () => {
          const refreshed = await options.refresher.refresh({ session: { sessionId: "session-1", threadKey: "child-thread" } }, 0);
          expect(refreshed.messages).toHaveLength(1);
          expect(refreshed.messages[0]?.content).toContain("[agent-message kind=request id=mailbox-1");
          expect(refreshed.messages[0]?.content).toContain("please continue");
          expect(mailbox.ack).not.toHaveBeenCalled();
          await refreshed.onInvokeSuccess?.();
          const retried = await options.refresher.refresh({ session: { sessionId: "session-1", threadKey: "child-thread" } }, 0);
          expect(retried.messages).toHaveLength(0);
          await retried.onInvokeSuccess?.();
          return { content: "done", contentParts: [], finishReason: "stop", metadata: {} };
        })(),
      }),
      close: vi.fn(),
    }));

    const result = await executeRunWithSdk(base, input({ threadKey: "child-thread", childAgentId: "child-1" }));
    expect(result.success).toBe(true);
    expect(mailbox.claim).toHaveBeenCalledTimes(2);
    expect(mailbox.ack).toHaveBeenCalledTimes(2);
    expect(mailbox.ack).toHaveBeenCalledWith(expect.objectContaining({ messageId: "mailbox-1", claimId: "claim-1" }));
    expect(base.storage.conversation.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "mailbox-1",
      childAgentId: "child-1",
      threadKey: "child-thread",
      metadata: expect.objectContaining({
        agent_message: true,
        agent_message_display_content: "please continue",
        agent_message_target_child_agent_id: "child-1",
        agent_message_target_thread_key: "child-thread",
        visible_to_user: false,
      }),
    }));
  });

  it("按 mailbox visible_to_user=true 写入 conversation", async () => {
    runtimeMock.createRuntime.mockReset();
    let history: any[] = [];
    const message = mailboxMessage({
      message_id: "user-mailbox-1",
      input_type: "user_message",
      source_kind: "user",
      visible_to_user: true,
      sent_at: "2026-01-01T00:00:00.000Z",
      target_thread_key: "root",
      target_child_agent_id: null,
      claim_id: "claim-user-1",
      content_parts: [{ type: "text", text: "user follow-up" }],
    });
    const mailbox: AgentMailboxStorePort = {
      claim: vi.fn(async () => [message]),
      ack: vi.fn(async () => true),
      settle: vi.fn(async () => true),
      release: vi.fn(async () => true),
      enqueue: vi.fn(),
      get: vi.fn(async () => null),
      expire: vi.fn(async () => 0),
    };
    const base = deps(
      vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] })),
      vi.fn(async () => ({ kind: "started", run: {} })),
      vi.fn(async () => undefined),
    );
    base.storage.agentMailbox = mailbox;
    base.storage.conversation.getRecentMessages = vi.fn(async () => history);
    base.storage.conversation.getMessageById = vi.fn(async () => null);
    base.storage.conversation.addMessage = vi.fn(async (inputMessage) => {
      const created = {
        seq: 1,
        id: inputMessage.messageId ?? message.message_id,
        session_id: inputMessage.sessionId,
        role: inputMessage.role,
        content: inputMessage.content,
        content_parts: inputMessage.contentParts,
        metadata: inputMessage.metadata ?? {},
        thread_key: inputMessage.threadKey ?? "root",
        child_agent_id: inputMessage.childAgentId ?? null,
        created_at: new Date(0).toISOString(),
      };
      history = [created];
      return created;
    });
    runtimeMock.createRuntime.mockImplementation((options: any) => ({
      run: () => ({
        runId: "run-1",
        events: (async function* () {})(),
        result: (async () => {
          const refreshed = await options.refresher.refresh({
            session: { sessionId: "session-1", threadKey: "root" },
          }, 0);
          expect(refreshed.messages).toHaveLength(1);
          expect(mailbox.ack).not.toHaveBeenCalled();
          await refreshed.onInvokeSuccess?.();
          return { content: "done", contentParts: [], finishReason: "stop", metadata: {} };
        })(),
      }),
      close: vi.fn(),
    }));

    const result = await executeRunWithSdk(base, input());

    expect(result.success).toBe(true);
    expect(base.storage.conversation.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "user-mailbox-1",
      metadata: expect.objectContaining({ visible_to_user: true }),
    }));
    expect(mailbox.ack).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "user-mailbox-1",
      claimId: "claim-user-1",
    }));
    expect(base.eventPublisher.publishAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      message: expect.objectContaining({
        metadata: expect.objectContaining({
          execution_kind: "agent_stream",
          run_id: "run-1",
          consumed_by_run_id: "run-1",
          visible_to_user: true,
        }),
      }),
    }));
  });

  it("把活跃 run 消费的 queued user message 规范化为 execution injection", async () => {
    runtimeMock.createRuntime.mockReset();
    let history: any[] = [];
    const message = mailboxMessage({
      message_id: "followup-mailbox-1",
      input_type: "user_message",
      source_kind: "user",
      visible_to_user: true,
      target_thread_key: "root",
      target_child_agent_id: null,
      claim_id: "claim-followup-1",
      content_parts: [{ type: "text", text: "more detail" }],
      metadata: { request_id: "req-followup", run_id: "queued-run", execution_kind: "agent_stream" },
    });
    const mailbox: AgentMailboxStorePort = {
      claim: vi.fn(async () => [message]),
      ack: vi.fn(async () => true),
      settle: vi.fn(async () => true),
      release: vi.fn(async () => true),
      enqueue: vi.fn(),
      get: vi.fn(async () => null),
      expire: vi.fn(async () => 0),
    };
    const base = deps(
      vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] })),
      vi.fn(async () => ({ kind: "started", run: {} })),
      vi.fn(async () => undefined),
    );
    base.storage.agentMailbox = mailbox;
    base.storage.conversation.getRecentMessages = vi.fn(async () => history);
    base.storage.conversation.getMessageById = vi.fn(async () => null);
    base.storage.conversation.addMessage = vi.fn(async (inputMessage) => {
      const created = {
        seq: 9,
        id: inputMessage.messageId ?? message.message_id,
        session_id: inputMessage.sessionId,
        role: inputMessage.role,
        content: inputMessage.content,
        content_parts: inputMessage.contentParts,
        metadata: inputMessage.metadata ?? {},
        thread_key: inputMessage.threadKey ?? "root",
        child_agent_id: inputMessage.childAgentId ?? null,
        created_at: new Date(0).toISOString(),
      };
      history = [created];
      return created;
    });
    runtimeMock.createRuntime.mockImplementation((options: any) => ({
      run: () => ({
        runId: "run-1",
        events: (async function* () {})(),
        result: (async () => {
          const refreshed = await options.refresher.refresh({ session: { sessionId: "session-1", threadKey: "root" } }, 4);
          await refreshed.onInvokeSuccess?.();
          return { content: "done", contentParts: [], finishReason: "stop", metadata: {} };
        })(),
      }),
      close: vi.fn(),
    }));

    await expect(executeRunWithSdk(base, input())).resolves.toMatchObject({ success: true });
    expect(base.storage.conversation.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        execution_kind: "session_followup",
        source: "running_session",
        run_id: "run-1",
        consumed_by_run_id: "run-1",
        round_index: 4,
      }),
    }));
  });

  it("invoke 失败时 release mailbox 消息回 queued 并可重试", async () => {
    runtimeMock.createRuntime.mockReset();
    let history: any[] = [];
    let status: AgentMailboxMessage["status"] = "queued";
    const invokeError = new Error("provider failed");
    const message = mailboxMessage({ message_id: "mailbox-retryable", claim_id: "claim-retryable" });
    const mailbox: AgentMailboxStorePort = {
      claim: vi.fn(async () => {
        if (status !== "queued") return [];
        status = "claimed";
        return [{ ...message, status }];
      }),
      ack: vi.fn(async () => {
        status = "acked";
        return true;
      }),
      settle: vi.fn(async () => true),
      release: vi.fn(async () => {
        status = "queued";
        return true;
      }),
      enqueue: vi.fn(),
      get: vi.fn(async () => ({ ...message, status })),
      expire: vi.fn(async () => 0),
    };
    const base = deps(
      vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] })),
      vi.fn(async () => ({ kind: "started", run: {} })),
      vi.fn(async () => undefined),
    );
    base.storage.agentMailbox = mailbox;
    base.storage.conversation.getRecentMessages = vi.fn(async () => history);
    base.storage.conversation.getMessageById = vi.fn(async () => history[0] ?? null);
    base.storage.conversation.addMessage = vi.fn(async (inputMessage) => {
      const created = {
        seq: 1,
        id: inputMessage.messageId ?? message.message_id,
        session_id: inputMessage.sessionId,
        role: inputMessage.role,
        content: inputMessage.content,
        content_parts: inputMessage.contentParts,
        metadata: inputMessage.metadata ?? {},
        thread_key: inputMessage.threadKey ?? "root",
        child_agent_id: inputMessage.childAgentId ?? null,
        created_at: new Date(0).toISOString(),
      };
      history = [created];
      return created;
    });
    runtimeMock.createRuntime.mockImplementation((options: any) => ({
      run: () => ({
        runId: "run-1",
        events: (async function* () {})(),
        result: (async () => {
          const refreshed = await options.refresher.refresh({
            session: { sessionId: "session-1", threadKey: "child-thread" },
          }, 0);
          expect(status).toBe("claimed");
          expect(mailbox.ack).not.toHaveBeenCalled();
          await refreshed.onInvokeFailure?.(invokeError);
          throw invokeError;
        })(),
      }),
      close: vi.fn(),
    }));

    const result = await executeRunWithSdk(base, input({ threadKey: "child-thread", childAgentId: "child-1" }));

    expect(result.success).toBe(false);
    expect(status).toBe("queued");
    expect(mailbox.ack).not.toHaveBeenCalled();
    expect(mailbox.release).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "mailbox-retryable",
      claimId: "claim-retryable",
      lastError: "provider failed",
    }));
    const retried = await mailbox.claim({
      sessionId: "session-1",
      targetRunId: "run-1",
      targetAgentCallId: "call-1",
      targetThreadKey: "child-thread",
      targetChildAgentId: "child-1",
      claimId: "claim-retry-2",
      consumerId: "worker-2",
    });
    expect(retried).toHaveLength(1);
    expect(retried[0]?.message_id).toBe("mailbox-retryable");
  });

  it("重领已经进入初始上下文的 mailbox 消息时只 ACK 不重复追加", async () => {
    runtimeMock.createRuntime.mockReset();
    const historyMessage: MessageInfo = {
      seq: 1,
      id: "mailbox-retry",
      session_id: "session-1",
      role: "user",
      content: "[agent-message kind=request id=mailbox-retry]\nplease continue\n[/agent-message]",
      content_parts: [{ type: "text", text: "please continue" }],
      metadata: { agent_message: true },
      thread_key: "child-thread",
      child_agent_id: "child-1",
      created_at: new Date(0).toISOString(),
    };
    const mailbox: AgentMailboxStorePort = {
      claim: vi.fn(async () => [{
        seq: 1,
        message_id: "mailbox-retry",
        tenant_id: "tenant-1",
        session_id: "session-1",
        source_run_id: "parent-run",
        source_agent_call_id: "parent-call",
        target_run_id: "run-1",
        target_agent_call_id: "call-1",
        target_thread_key: "child-thread",
        target_child_agent_id: "child-1",
        kind: "request",
        correlation_id: "corr-1",
        reply_to_message_id: null,
        content_parts: [{ type: "text", text: "please continue" }],
        metadata: {},
        status: "claimed",
        attempt_count: 2,
        claim_id: "claim-retry",
        claimed_by: "worker",
        claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
        available_at: new Date(0).toISOString(),
        expires_at: null,
        last_error: "previous context build failed",
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        acked_at: null,
      }] as any),
      ack: vi.fn(async () => true),
      settle: vi.fn(async () => true),
      release: vi.fn(async () => true),
      enqueue: vi.fn(),
      get: vi.fn(async () => null),
      expire: vi.fn(async () => 0),
    };
    const base = deps(
      vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] })),
      vi.fn(async () => ({ kind: "started", run: {} })),
      vi.fn(async () => undefined),
    );
    base.storage.agentMailbox = mailbox;
    base.storage.conversation.getRecentMessages = vi.fn(async () => [historyMessage]);
    base.storage.conversation.getMessageById = vi.fn(async () => historyMessage);
    base.storage.conversation.addMessage = vi.fn();
    runtimeMock.createRuntime.mockImplementation((options: any) => ({
      run: () => ({
        runId: "run-1",
        events: (async function* () {})(),
        result: (async () => {
          const refreshed = await options.refresher.refresh({
            session: { sessionId: "session-1", threadKey: "child-thread" },
          }, 0);
          expect(refreshed.messages).toHaveLength(0);
          expect(mailbox.ack).not.toHaveBeenCalled();
          await refreshed.onInvokeSuccess?.();
          return { content: "done", contentParts: [], finishReason: "stop", metadata: {} };
        })(),
      }),
      close: vi.fn(),
    }));

    const result = await executeRunWithSdk(base, input({ threadKey: "child-thread", childAgentId: "child-1" }));

    expect(result.success).toBe(true);
    expect(mailbox.ack).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "mailbox-retry",
      claimId: "claim-retry",
    }));
    expect(base.storage.conversation.addMessage).not.toHaveBeenCalled();
  });

  it("startRun 已提交后初始化回调失败也会落 failed 终态消息", async () => {
    runtimeMock.createRuntime.mockReset();
    const startRun = vi.fn(async () => ({ kind: "started", run: {} }));
    const persist = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] }));
    const error = new Error("start callback failed");
    const result = await executeRunWithSdk(
      deps(finalize, startRun, persist),
      input({ onStartDisposition: () => { throw error; } }),
    );

    expect(result.success).toBe(false);
    expect(result.content).toBe("start callback failed");
    expect(finalize).toHaveBeenCalledWith("failed", null, error);
  });

  it("SDK result 成功但事件持久化失败时仍会落 failed 终态消息", async () => {
    runtimeMock.createRuntime.mockReset();
    const startRun = vi.fn(async () => ({ kind: "started", run: {} }));
    const persistError = new Error("event persistence failed");
    const persist = vi.fn(async () => { throw persistError; });
    const finalize = vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] }));
    const close = vi.fn();
    runtimeMock.createRuntime.mockReturnValue({
      run: () => ({
        runId: "run-1",
        events: (async function* () {
          yield { type: "assistant_intermediate", message: { content: "partial", contentParts: [] }, round: 0 };
        })(),
        result: Promise.resolve({ content: "done", contentParts: [], finishReason: "stop", metadata: {} }),
      }),
      close,
    });

    const result = await executeRunWithSdk(deps(finalize, startRun, persist), input());

    expect(result.success).toBe(false);
    expect(result.content).toBe("event persistence failed");
    expect(finalize).toHaveBeenCalledWith("failed", null, persistError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("consumes a cancel mailbox message and interrupts at the round boundary", async () => {
    runtimeMock.createRuntime.mockReset();
    const controller = new AbortController();
    const startRun = vi.fn(async () => ({ kind: "started", run: {} }));
    const persist = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] }));
    const base = deps(finalize, startRun, persist);
    const cancelMessage = {
      seq: 1,
      message_id: "cancel-1",
      tenant_id: "tenant-1",
      session_id: "session-1",
      source_run_id: "parent-run",
      source_agent_call_id: "parent-call",
      target_run_id: "run-1",
      target_agent_call_id: "call-1",
      target_thread_key: "child-thread",
      target_child_agent_id: "child-1",
      kind: "cancel",
      input_type: "agent_message",
      source_kind: "agent",
      visible_to_user: false,
      sent_at: null,
      correlation_id: "corr-cancel",
      reply_to_message_id: null,
      content_parts: [{ type: "text", text: "stop now" }],
      metadata: {},
      status: "claimed",
      attempt_count: 1,
      claim_id: "claim-cancel",
      claimed_by: "worker",
      claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
      available_at: new Date(0).toISOString(),
      expires_at: null,
      last_error: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      acked_at: null,
    };
    const mailbox: AgentMailboxStorePort = {
      claim: vi.fn(async () => [cancelMessage] as any),
      ack: vi.fn(async () => true),
      settle: vi.fn(async () => true),
      release: vi.fn(async () => true),
      enqueue: vi.fn(),
      get: vi.fn(async () => null),
      expire: vi.fn(async () => 0),
    };
    base.storage.agentMailbox = mailbox;
    base.storage.conversation.getRecentMessages = vi.fn(async () => []);
    base.storage.conversation.getMessageById = vi.fn(async () => null);
    base.storage.conversation.addMessage = vi.fn(async (message) => ({
      seq: 1,
      id: message.messageId ?? "cancel-1",
      session_id: message.sessionId,
      role: message.role,
      content: message.content,
      content_parts: message.contentParts,
      metadata: message.metadata ?? {},
      thread_key: message.threadKey ?? "root",
      child_agent_id: message.childAgentId ?? null,
      created_at: new Date(0).toISOString(),
    })) as any;
    runtimeMock.createRuntime.mockImplementation((options: any) => ({
      run: () => ({
        runId: "run-1",
        events: (async function* () {})(),
        result: options.refresher.refresh({ session: { sessionId: "session-1", threadKey: "child-thread" } }, 0),
      }),
      close: vi.fn(),
    }));

    const result = await executeRunWithSdk(base, input({
      threadKey: "child-thread",
      childAgentId: "child-1",
      signal: controller.signal,
      abortController: controller,
    }));

    expect(controller.signal.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(finalize).toHaveBeenCalledWith("interrupted", null, expect.any(Error));
    expect(mailbox.ack).toHaveBeenCalledWith(expect.objectContaining({ messageId: "cancel-1", claimId: "claim-cancel" }));
    expect(mailbox.release).not.toHaveBeenCalled();
  });
});
