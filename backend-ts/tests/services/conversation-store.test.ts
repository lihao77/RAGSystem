import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

describe("ConversationStore", () => {
  it("持久化 session permission_mode，并在幂等 create 时保留已有值", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-ts-session-permission-"));
    const dbPath = path.join(root, "conversation.db");
    try {
      const first = createConversationStore({ dbPath, dataRoot: root });
      first.createSession(LOCAL_TENANT_ID, "permission-session", "usr_local", {}, "relaxed");
      first.createSession(LOCAL_TENANT_ID, "permission-session", "usr_local", {}, null);
      expect(first.getSession("permission-session")?.permission_mode).toBe("relaxed");
      expect(first.updateSessionPermissionMode("permission-session", "standard")).toBe(true);
      first.close();

      const reopened = createConversationStore({ dbPath, dataRoot: root });
      expect(reopened.getSession("permission-session")?.permission_mode).toBe("standard");
      reopened.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("upserts sessions and returns Python-compatible session list metadata", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", "u1", { title: "Pinned title", unread_count: 2 });
    store.addMessage({ sessionId: "s1", role: "user", content: "first message" });
    store.addMessage({ sessionId: "s1", role: "assistant", content: "latest answer" });

    const listed = store.listSessions(LOCAL_TENANT_ID, 20, 0, ["u1"]);

    expect(listed).toMatchObject({
      total: 1,
      limit: 20,
      offset: 0,
      has_more: false,
      items: [
        {
          session_id: "s1",
          user_id: "u1",
          title: "Pinned title",
          last_message: "latest answer",
          first_message: "first message",
          unread_count: 2,
        },
      ],
    });
    store.close();
  });

  it("falls back to the first message prefix for session title", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", null, {});
    store.addMessage({ sessionId: "s1", role: "user", content: "123456789012345678901234567890abc" });

    const [item] = store.listSessions(LOCAL_TENANT_ID, 20, 0).items;

    expect(item?.title).toBe("123456789012345678901234567890");
    store.close();
  });

  it("merges session metadata patches without replacing sibling keys", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", null, {
      title: "Pinned",
      memory_prefix_states: {
        "root::agent": { rendered_block: "old" },
      },
    });

    const updated = store.updateSessionMetadata("s1", {
      memory_prefix_states: {
        "child::agent": { rendered_block: "child" },
      },
    });

    expect(updated).toMatchObject({
      title: "Pinned",
      memory_prefix_states: {
        "root::agent": { rendered_block: "old" },
        "child::agent": { rendered_block: "child" },
      },
    });
    expect(store.getSession("s1")?.metadata).toEqual(updated);
    store.close();
  });

  it("returns the latest window in ascending sequence order", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    store.addMessage({ sessionId: "s1", role: "user", content: "m1" });
    store.addMessage({ sessionId: "s1", role: "assistant", content: "m2" });
    store.addMessage({ sessionId: "s1", role: "user", content: "m3" });

    const messages = store.listMessages("s1", 2, 0);

    expect(messages.total).toBe(3);
    expect(messages.items.map((item) => item.content)).toEqual(["m2", "m3"]);
    expect(messages.has_more).toBe(true);
    store.close();
  });

  it("deletes messages after seq but keeps the anchor", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    const first = store.addMessage({ sessionId: "s1", role: "user", content: "m1" });
    store.addMessage({ sessionId: "s1", role: "assistant", content: "m2" });
    store.addMessage({ sessionId: "s1", role: "user", content: "m3" });

    const deleted = store.deleteMessagesAfter("s1", { afterSeq: first.seq });

    expect(deleted).toBe(2);
    expect(store.listMessages("s1", 20, 0).items.map((item) => item.content)).toEqual(["m1"]);
    store.close();
  });

  it("updates messages only when session and role filters match", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    const user = store.addMessage({ sessionId: "s1", role: "user", content: "old" });
    const assistant = store.addMessage({ sessionId: "s1", role: "assistant", content: "answer" });

    expect(store.updateMessage({ messageId: user.id, sessionId: "s1", roleFilter: "user", content: "new" })).toBe(true);
    expect(store.updateMessage({ messageId: assistant.id, sessionId: "s1", roleFilter: "user", content: "bad" })).toBe(false);
    expect(store.updateMessage({ messageId: user.id, sessionId: "other", roleFilter: "user", content: "bad" })).toBe(false);
    expect(store.listMessages("s1", 20, 0).items.map((item) => item.content)).toEqual(["new", "answer"]);
    store.close();
  });

  it("deletes child agents created after the rollback anchor", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    const anchor = store.addMessage({ sessionId: "s1", role: "user", content: "m1" });
    const later = store.addMessage({ sessionId: "s1", role: "assistant", content: "m2" });
    store.createChildAgent({ sessionId: "s1", childAgentId: "before", agentName: "worker", createdSeq: anchor.seq });
    store.createChildAgent({ sessionId: "s1", childAgentId: "after", agentName: "worker", createdSeq: later.seq });

    const deleted = store.deleteMessagesAfter("s1", { afterSeq: anchor.seq });
    const children = store.listChildAgents({ sessionId: "s1" });

    expect(deleted).toBe(1);
    expect(children.items.map((item) => item.child_agent_id)).toEqual(["before"]);
    store.close();
  });

  it("stores run steps with per-run step order and message binding", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    const assistant = store.addMessage({
      sessionId: "s1",
      role: "assistant",
      content: "answer",
      metadata: { run_id: "run-1" },
    });
    const first = store.addRunStep({
      sessionId: "s1",
      runId: "run-1",
      stepType: "protocol.envelope.v1",
      payload: { type: "tool_call", session_id: "s1", run_id: "run-1", payload: { tool: "read_file", phase: "start" } },
    });
    const second = store.addRunStep({
      sessionId: "s1",
      runId: "run-1",
      stepType: "protocol.envelope.v1",
      payload: { type: "stream_output", session_id: "s1", run_id: "run-1", payload: { phase: "final", content: "done" } },
    });

    const updated = store.updateRunStepsMessageId("s1", "run-1", assistant.id);
    const steps = store.listRunSteps({ messageId: assistant.id, sessionId: "s1" });

    expect(first.step_order).toBe(1);
    expect(second.step_order).toBe(2);
    expect(updated).toBe(2);
    expect(steps.map((step) => step.payload.type)).toEqual(["tool_call", "stream_output"]);
    store.close();
  });

  it("records durable outbox rows with per-session sequence and delivery status", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", "usr_local");
    store.createSession(LOCAL_TENANT_ID, "s2", "usr_local");

    const first = store.appendOutbox({
      sessionId: "s1",
      runId: "run-1",
      eventType: "run.completed",
      aggregateType: "run",
      aggregateId: "run-1",
      payload: { status: "completed" },
    });
    const second = store.appendOutbox({
      sessionId: "s1",
      runId: "run-1",
      eventType: "message.saved",
      aggregateType: "message",
      aggregateId: "msg-1",
      payload: { id: "msg-1" },
    });
    const otherSession = store.appendOutbox({
      sessionId: "s2",
      runId: "run-2",
      eventType: "run.completed",
      aggregateType: "run",
      aggregateId: "run-2",
      payload: { status: "completed" },
    });

    expect([first.session_seq, second.session_seq, otherSession.session_seq]).toEqual([1, 2, 1]);
    expect(JSON.parse(first.payload)).toEqual({ status: "completed" });
    expect(store.fetchPendingOutbox(10).map((row) => row.event_id)).toEqual([
      first.event_id,
      second.event_id,
      otherSession.event_id,
    ]);
    expect(store.markOutboxDelivered(first.id)).toBe(true);
    expect(store.markOutboxFailed(second.id, "projection failed")).toBe(true);

    const pending = store.fetchPendingOutbox(10);
    expect(pending.map((row) => row.event_id)).toEqual([otherSession.event_id]);
    store.close();
  });

  it("manages failed and delivered outbox rows for operations", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "ops-outbox", "usr_local");
    const pending = store.appendOutbox({
      sessionId: "ops-outbox",
      runId: "run-pending",
      eventId: "event-pending",
      eventType: "run.completed",
      aggregateType: "run",
      aggregateId: "run-pending",
      payload: { status: "completed" },
    });
    const retrying = store.appendOutbox({
      sessionId: "ops-outbox",
      runId: "run-retrying",
      eventId: "event-retrying",
      eventType: "run.failed",
      aggregateType: "run",
      aggregateId: "run-retrying",
      payload: { status: "failed" },
    });
    const failed = store.appendOutbox({
      sessionId: "ops-outbox",
      runId: "run-failed",
      eventId: "event-failed",
      eventType: "run.failed",
      aggregateType: "run",
      aggregateId: "run-failed",
      payload: { status: "failed" },
    });
    const delivered = store.appendOutbox({
      sessionId: "ops-outbox",
      runId: "run-delivered",
      eventId: "event-delivered",
      eventType: "run.completed",
      aggregateType: "run",
      aggregateId: "run-delivered",
      payload: { status: "completed" },
    });

    expect(store.markOutboxRetrying(retrying.id, "retry later", "2999-01-01T00:00:00.000Z")).toBe(true);
    expect(store.markOutboxFailed(failed.id, "projection failed")).toBe(true);
    expect(store.markOutboxDelivered(delivered.id)).toBe(true);

    expect(store.listOutbox({ statuses: ["failed", "retrying"], limit: 10 }).items.map((row) => row.event_id)).toEqual([
      "event-retrying",
      "event-failed",
    ]);
    expect(store.listOutbox({ runId: "run-failed" }).items.map((row) => row.id)).toEqual([failed.id]);
    expect(store.getOutboxRow(failed.id)).toMatchObject({
      event_id: "event-failed",
      status: "failed",
      last_error: "projection failed",
    });

    expect(store.retryOutbox(pending.id)).toBe(false);
    expect(store.retryOutbox(failed.id)).toBe(true);
    expect(store.getOutboxRow(failed.id)).toMatchObject({
      status: "pending",
      last_error: null,
      locked_at: null,
    });

    expect(store.retryOutboxBatch({ statuses: ["retrying"], limit: 10 })).toEqual({
      matched: 1,
      retried: 1,
      ids: [retrying.id],
    });
    expect(store.getOutboxStats()).toMatchObject({
      total: 4,
      pending: 3,
      retrying: 0,
      delivered: 1,
      failed: 0,
      recent_failed_errors: [],
      oldest_pending_created_at: expect.any(String),
      oldest_pending_or_retrying_created_at: expect.any(String),
    });

    expect(store.deleteDeliveredOutbox({ before: "2999-01-01T00:00:00.000Z", limit: 10 })).toBe(1);
    expect(store.listOutbox({ statuses: ["delivered"] }).items).toEqual([]);
    store.close();
  });

  it("rolls back core state and outbox writes from the transaction facade", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s-rollback", "usr_local");
    store.createSession(LOCAL_TENANT_ID, "s-rollback", "usr_local");

    expect(() =>
      store.runInTransaction((tx) => {
        const message = tx.addMessage({
          sessionId: "s-rollback",
          role: "assistant",
          content: "uncommitted",
        });
        tx.addRunStep({
          sessionId: "s-rollback",
          runId: "run-rollback",
          stepType: "protocol.envelope.v1",
          payload: { type: "stream_output", session_id: "s-rollback", payload: { phase: "final" } },
          messageId: message.id,
        });
        tx.appendOutbox({
          sessionId: "s-rollback",
          runId: "run-rollback",
          eventType: "run.completed",
          aggregateType: "run",
          aggregateId: "run-rollback",
          payload: { final_message_id: message.id },
        });
        throw new Error("rollback sentinel");
      }),
    ).toThrow("rollback sentinel");

    expect(store.listMessages("s-rollback", 20, 0).items).toEqual([]);
    expect(store.listRunSteps({ sessionId: "s-rollback", runId: "run-rollback" })).toEqual([]);
    expect(store.fetchPendingOutbox(10)).toEqual([]);
    store.close();
  });

  it("persists runs, resources, and step resource links like Python", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-ts-store-"));
    const store = createConversationStore({
      dbPath: path.join(root, "conversation.db"),
      dataRoot: path.join(root, "data"),
    });
    try {
      store.createSession(LOCAL_TENANT_ID, "session-1", "user-1");
      const run = store.createRun({
        runId: "run-1",
        sessionId: "session-1",
        entrypoint: "execute",
        status: "running",
        taskSummary: "demo task",
        requestId: "request-1",
        userId: "user-1",
        agentName: "orchestrator_agent",
      });
      const message = store.addMessage({
        sessionId: "session-1",
        role: "assistant",
        content: "done",
        metadata: { run_id: "run-1", msg_type: "assistant_final" },
      });
      const step = store.addRunStep({
        sessionId: "session-1",
        runId: "run-1",
        stepType: "call.tool.end",
        payload: { call_id: "call-1", tool_name: "write_file" },
        messageId: message.id,
      });
      const resource = store.registerResource({
        sessionId: "session-1",
        runId: "run-1",
        stepId: step.id,
        messageId: message.id,
        resourceType: "data",
        subType: "text",
        title: "output",
        path: path.join(root, "output.txt"),
        sourceTool: "write_file",
        scope: "transient",
      });

      store.attachResourceToStep("session-1", "run-1", step.id, resource.resource_id);
      expect(store.updateRunStatus("run-1", "session-1", "completed", message.id)).toBe(true);

      const runs = store.listRuns("session-1");
      const resources = store.listResources("session-1", "run-1");
      const steps = store.listRunSteps({ runId: "run-1", sessionId: "session-1" });

      expect(run).toMatchObject({ run_id: "run-1", status: "running", thread_key: "root" });
      expect(runs.items[0]).toMatchObject({
        status: "completed",
        request_id: "request-1",
        final_message_id: message.id,
      });
      expect(store.getPersistedExecutionOverview(false).items[0]).toMatchObject({
        run_id: "run-1",
        request_id: "request-1",
      });
      expect(resources.items[0]).toMatchObject({ resource_id: resource.resource_id, source_tool: "write_file" });
      expect(steps[0]?.payload.resource_refs).toEqual([{ resource_id: resource.resource_id }]);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports child-scoped messages and run metadata", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      store.createSession(LOCAL_TENANT_ID, "session-thread", "user-1");
      const child = store.createChildAgent({
        childAgentId: "child-1",
        sessionId: "session-thread",
        agentName: "kgqa_agent",
        parentRunId: "run-root",
        parentCallId: "call-parent",
      });

      store.addMessage({
        sessionId: "session-thread",
        role: "assistant",
        content: "child-answer",
        metadata: { run_id: "run-child" },
        threadKey: child.thread_key,
        childAgentId: "child-1",
      });
      store.createRun({
        runId: "run-child",
        sessionId: "session-thread",
        entrypoint: "send_message",
        status: "running",
        taskSummary: "child task",
        userId: "user-1",
        agentName: "kgqa_agent",
        threadKey: child.thread_key,
        parentRunId: "run-root",
        parentCallId: "call-parent",
        childAgentId: "child-1",
      });

      const childMessages = store.getRecentMessagesByChildAgent("session-thread", "child-1", 20);
      const runs = store.listRuns("session-thread");
      const children = store.listChildAgents({ sessionId: "session-thread" });

      expect(child.thread_key).toBe("child:child-1");
      expect(childMessages.map((item) => item.content)).toEqual(["child-answer"]);
      expect(childMessages[0]).toMatchObject({ child_agent_id: "child-1" });
      expect(runs.items[0]).toMatchObject({ child_agent_id: "child-1" });
      expect(children.items[0]).toMatchObject({ child_agent_id: "child-1" });
    } finally {
      store.close();
    }
  });

  it("infers resource scopes from managed session paths and workspace metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-ts-scopes-"));
    const dataRoot = path.join(root, "data");
    const store = createConversationStore({
      dbPath: path.join(root, "conversation.db"),
      dataRoot,
    });
    try {
      const sessionId = "session-scope";
      const runId = "run-1";
      const workspaceRoot = path.join(root, "workspace");
      store.createSession(LOCAL_TENANT_ID, sessionId, null, { workspace_root: workspaceRoot });

      const transient = store.registerResource({
        sessionId,
        path: path.join(dataRoot, "sessions", sessionId, "transient", "data.json"),
        resourceType: "data",
        sourceTool: "demo",
      });
      const exported = store.registerResource({
        sessionId,
        runId,
        path: path.join(dataRoot, "sessions", sessionId, "exports", runId, "out.txt"),
        resourceType: "data",
        sourceTool: "demo",
      });
      const session = store.registerResource({
        sessionId,
        path: path.join(dataRoot, "sessions", sessionId, "visualizations", "viz.json"),
        resourceType: "artifact",
        sourceTool: "demo",
      });
      const workspace = store.registerResource({
        sessionId,
        path: path.join(workspaceRoot, "demo.txt"),
        resourceType: "data",
        sourceTool: "demo",
      });

      expect(transient.scope).toBe("transient");
      expect(exported.scope).toBe("export");
      expect(session.scope).toBe("session");
      expect(workspace.scope).toBe("workspace");
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
