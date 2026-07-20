import { describe, expect, it, vi } from "vitest";

import { SaaSSessionApplication } from "../../src/adapters/saas/application/session/saas-session-application.js";

describe("SaaSSessionApplication", () => {
  it("binds creates and lists to its tenant", async () => {
    const repository = {
      createSession: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0, has_more: false }),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never);

    await application.createSession({ sessionId: "session-1", userId: "user-1", metadata: { team: "default" } });
    await application.listSessions({ limit: 10, offset: 0, userIds: ["user-1"] });

    expect(repository.createSession).toHaveBeenCalledWith("tenant-a", "session-1", "user-1", { team: "default" }, null);
    expect(repository.listSessions).toHaveBeenCalledWith("tenant-a", 10, 0, ["user-1"]);
  });

  it("does not expose or mutate a session owned by another tenant", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-b" }),
      deleteSession: vi.fn(),
      listVisibleRootMessages: vi.fn(),
      updateMessage: vi.fn(),
      deleteMessagesAfter: vi.fn(),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never);

    await expect(application.getSession("session-1")).resolves.toBeNull();
    await expect(application.deleteSession("session-1")).resolves.toBe(false);
    await expect(application.listMessages({ sessionId: "session-1" })).resolves.toBeNull();
    await expect(application.updateUserMessage({ sessionId: "session-1", messageId: "message-1", content: "changed" })).resolves.toBe(false);
    await expect(application.rollbackMessages({ sessionId: "session-1", afterSeq: 1 })).resolves.toBe(0);
    expect(repository.deleteSession).not.toHaveBeenCalled();
    expect(repository.listVisibleRootMessages).not.toHaveBeenCalled();
    expect(repository.updateMessage).not.toHaveBeenCalled();
    expect(repository.deleteMessagesAfter).not.toHaveBeenCalled();
  });

  it("updates and rolls back messages through the tenant-bound repository", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-a" }),
      updateMessage: vi.fn().mockResolvedValue(true),
      deleteMessagesAfter: vi.fn().mockResolvedValue(2),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never);

    await expect(application.updateUserMessage({ sessionId: "session-1", messageId: "message-1", content: "changed" })).resolves.toBe(true);
    await expect(application.rollbackMessages({ sessionId: "session-1", afterMessageId: "message-1" })).resolves.toBe(2);

    expect(repository.updateMessage).toHaveBeenCalledWith({ sessionId: "session-1", messageId: "message-1", content: "changed", roleFilter: "user" });
    expect(repository.deleteMessagesAfter).toHaveBeenCalledWith("session-1", { afterSeq: null, afterMessageId: "message-1" });
  });

  it("supports the asynchronous execution-session write port", async () => {
    const userMessage = {
      id: "message-1",
      session_id: "session-1",
      seq: 4,
      role: "user",
      content: "retry me",
      metadata: {},
      tool_calls: [],
      tool_call_id: null,
      name: null,
      thread_key: "root",
      child_agent_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const repository = {
      createSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-a" }),
      addMessage: vi.fn().mockResolvedValue(userMessage),
      getMessageBySeq: vi.fn().mockResolvedValue(userMessage),
      updateMessage: vi.fn().mockResolvedValue(true),
      deleteMessagesAfter: vi.fn().mockResolvedValue(2),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never);

    await application.createSystemSession({ sessionId: "system-session" });
    await expect(application.addMessage({
      sessionId: "session-1",
      role: "user",
      content: "retry me",
    })).resolves.toEqual(userMessage);
    await expect(application.prepareRetry({
      sessionId: "session-1",
      afterSeq: 4,
      modifyUserMessage: "changed",
    })).resolves.toMatchObject({ deleted: 2, task: "changed", message: { content: "changed" } });

    expect(repository.createSession).toHaveBeenCalledWith("tenant-a", "system-session", null, {}, null);
    expect(repository.addMessage).toHaveBeenCalledTimes(1);
    expect(repository.updateMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "message-1",
      content: "changed",
      roleFilter: "user",
    }));
  });

  it("returns only repository-filtered root messages and marks final assistant execution", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-a" }),
      listVisibleRootMessages: vi.fn().mockResolvedValue({
        items: [
          { id: "user-1", role: "user", metadata: {} },
          { id: "assistant-1", role: "assistant", metadata: { run_id: "run-1" } },
        ],
        total: 2,
        limit: 20,
        offset: 0,
        has_more: false,
      }),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never);

    const result = await application.listMessages({ sessionId: "session-1" });

    expect(repository.listVisibleRootMessages).toHaveBeenCalledWith("session-1", 20, 0);
    expect(result?.items).toEqual([
      { id: "user-1", role: "user", metadata: {} },
      { id: "assistant-1", role: "assistant", metadata: { run_id: "run-1" }, has_execution: true },
    ]);
  });

  it("rewinds async file history before deleting SaaS messages", async () => {
    const calls: string[] = [];
    const repository = {
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-a" }),
      deleteMessagesAfter: vi.fn(async () => { calls.push("messages"); return 3; }),
    };
    const fileHistory = {
      hasSnapshots: vi.fn().mockResolvedValue(true),
      rewind: vi.fn(async () => { calls.push("files"); return { success: true, message: "ok", reverted_files: 1 }; }),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never, fileHistory as never);

    await expect(application.rollbackMessages({ sessionId: "session-1", afterSeq: 7 })).resolves.toBe(3);
    expect(fileHistory.rewind).toHaveBeenCalledWith("session-1", 7);
    expect(calls).toEqual(["files", "messages"]);
  });

  it("loads root and child run envelopes from the SaaS run repository", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-a" }),
      getMessageById: vi.fn().mockResolvedValue({
        id: "message-1",
        role: "assistant",
        metadata: { run_id: "root-run" },
        thread_key: "root",
      }),
    };
    const runs = {
      listRuns: vi.fn().mockResolvedValue({
        total: 3,
        items: [
          { run_id: "unrelated-run", parent_run_id: null, created_at: "2026-01-01T00:00:00.000Z" },
          { run_id: "child-run", parent_run_id: "root-run", created_at: "2026-01-01T00:00:02.000Z" },
          { run_id: "grandchild-run", parent_run_id: "child-run", created_at: "2026-01-01T00:00:03.000Z" },
        ],
      }),
      listRunSteps: vi.fn(async ({ runId }: { runId: string }) => [{
        step_type: "protocol.envelope.v1",
        payload: executionEnvelope(runId),
      }]),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never, null, runs as never);

    await expect(application.listMessageRunSteps({ sessionId: "session-1", messageId: "message-1" })).resolves.toMatchObject({
      message_id: "message-1",
      total: 3,
      items: [
        { type: "run_started", run_id: "root-run" },
        { type: "run_started", run_id: "child-run" },
        { type: "run_started", run_id: "grandchild-run" },
      ],
    });
    expect(runs.listRunSteps.mock.calls.map(([input]) => input.runId)).toEqual([
      "root-run",
      "child-run",
      "grandchild-run",
    ]);
  });

  it("loads durable root and child execution envelopes from the SaaS outbox", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-a" }),
      getMessageById: vi.fn().mockResolvedValue({
        id: "message-1",
        role: "assistant",
        metadata: { run_id: "root-run" },
        thread_key: "root",
      }),
    };
    const runs = {
      listRuns: vi.fn().mockResolvedValue({
        total: 2,
        items: [
          { run_id: "root-run", parent_run_id: null, created_at: "2026-01-01T00:00:00.000Z" },
          { run_id: "child-run", parent_run_id: "root-run", created_at: "2026-01-01T00:00:01.000Z" },
        ],
      }),
      listRunSteps: vi.fn(async ({ runId }: { runId: string }) => runId === "root-run"
        ? [{
            event_id: "event-1",
            step_type: "protocol.envelope.v1",
            payload: { ...executionEnvelope("root-run"), type: "agent_started" },
          }]
        : []),
    };
    const outbox = {
      listOutboxForReplay: vi.fn().mockResolvedValue([
        outboxRow(1, "root-run", { ...executionEnvelope("root-run"), type: "agent_started" }),
        outboxRow(2, "root-run", { ...executionEnvelope("root-run"), type: "state_sync" }),
        outboxRow(3, "child-run", { ...executionEnvelope("child-run"), type: "tool_call" }),
      ]),
    };
    const application = new SaaSSessionApplication("tenant-a" as never, repository as never, null, runs as never, outbox as never);

    const result = await application.listMessageRunSteps({ sessionId: "session-1", messageId: "message-1" });

    expect(result.items).toMatchObject([
      { type: "agent_started", run_id: "root-run", seq: 1 },
      { type: "tool_call", run_id: "child-run", seq: 3 },
    ]);
    expect(runs.listRunSteps).toHaveBeenCalledTimes(2);
    expect(outbox.listOutboxForReplay).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      sessionId: "session-1",
      runIds: ["root-run", "child-run"],
      limit: 500,
    });
  });

  it("falls back to message-bound steps when the assistant message has no run id", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-a" }),
      getMessageById: vi.fn().mockResolvedValue({ id: "message-1", role: "assistant", metadata: {}, thread_key: "root" }),
    };
    const runs = {
      listRuns: vi.fn(),
      listRunSteps: vi.fn().mockResolvedValue([
        { step_type: "internal.step", payload: {} },
        { step_type: "protocol.envelope.v1", payload: executionEnvelope("fallback-run") },
      ]),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never, null, runs as never);

    const result = await application.listMessageRunSteps({ sessionId: "session-1", messageId: "message-1" });

    expect(result.items).toHaveLength(1);
    expect(runs.listRuns).not.toHaveBeenCalled();
    expect(runs.listRunSteps).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      messageId: "message-1",
      sessionId: "session-1",
      limit: 500,
    });
  });

  it("does not query messages or runs for another tenant's session", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-b" }),
      getMessageById: vi.fn(),
    };
    const runs = { listRuns: vi.fn(), listRunSteps: vi.fn() };
    const application = new SaaSSessionApplication("tenant-a", repository as never, null, runs as never);

    await expect(application.listMessageRunSteps({ sessionId: "session-1", messageId: "message-1" }))
      .rejects.toThrow("会话不存在");
    expect(repository.getMessageById).not.toHaveBeenCalled();
    expect(runs.listRuns).not.toHaveBeenCalled();
    expect(runs.listRunSteps).not.toHaveBeenCalled();
  });
});

function executionEnvelope(runId: string) {
  return {
    type: "run_started",
    protocol_version: "1.0",
    session_id: "session-1",
    run_id: runId,
    payload: {},
  };
}

function outboxRow(seq: number, runId: string, event: Record<string, unknown>) {
  return {
    id: seq,
    event_id: `event-${seq}`,
    session_id: "session-1",
    tenant_id: "tenant-a",
    run_id: runId,
    session_seq: seq,
    event_type: `client.${String(event.type)}`,
    aggregate_type: "run",
    aggregate_id: runId,
    payload: JSON.stringify({ client_event: event }),
    status: "delivered",
    attempts: 0,
    available_at: null,
    locked_at: null,
    delivered_at: "2026-01-01T00:00:00.000Z",
    last_error: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}
