import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConversationStore } from "../../src/services/conversation-store.js";

describe("ConversationStore", () => {
  it("upserts sessions and returns Python-compatible session list metadata", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    store.createSession("s1", "u1", { title: "Pinned title", unread_count: 2 });
    store.addMessage({ sessionId: "s1", role: "user", content: "first message" });
    store.addMessage({ sessionId: "s1", role: "assistant", content: "latest answer" });

    const listed = store.listSessions(20, 0, "u1");

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
    const store = new ConversationStore({ dbPath: ":memory:" });
    store.createSession("s1", null, {});
    store.addMessage({ sessionId: "s1", role: "user", content: "123456789012345678901234567890abc" });

    const [item] = store.listSessions(20, 0).items;

    expect(item?.title).toBe("123456789012345678901234567890");
    store.close();
  });

  it("returns the latest window in ascending sequence order", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
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
    const store = new ConversationStore({ dbPath: ":memory:" });
    const first = store.addMessage({ sessionId: "s1", role: "user", content: "m1" });
    store.addMessage({ sessionId: "s1", role: "assistant", content: "m2" });
    store.addMessage({ sessionId: "s1", role: "user", content: "m3" });

    const deleted = store.deleteMessagesAfter("s1", { afterSeq: first.seq });

    expect(deleted).toBe(2);
    expect(store.listMessages("s1", 20, 0).items.map((item) => item.content)).toEqual(["m1"]);
    store.close();
  });

  it("updates messages only when session and role filters match", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    const user = store.addMessage({ sessionId: "s1", role: "user", content: "old" });
    const assistant = store.addMessage({ sessionId: "s1", role: "assistant", content: "answer" });

    expect(store.updateMessage({ messageId: user.id, sessionId: "s1", roleFilter: "user", content: "new" })).toBe(true);
    expect(store.updateMessage({ messageId: assistant.id, sessionId: "s1", roleFilter: "user", content: "bad" })).toBe(false);
    expect(store.updateMessage({ messageId: user.id, sessionId: "other", roleFilter: "user", content: "bad" })).toBe(false);
    expect(store.listMessages("s1", 20, 0).items.map((item) => item.content)).toEqual(["new", "answer"]);
    store.close();
  });

  it("deletes child agents created after the rollback anchor", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
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
    const store = new ConversationStore({ dbPath: ":memory:" });
    const assistant = store.addMessage({
      sessionId: "s1",
      role: "assistant",
      content: "answer",
      metadata: { run_id: "run-1" },
    });
    const first = store.addRunStep({
      sessionId: "s1",
      runId: "run-1",
      stepType: "execution.step",
      payload: { kind: "tool", result: "full", result_preview: "preview" },
    });
    const second = store.addRunStep({
      sessionId: "s1",
      runId: "run-1",
      stepType: "execution.step",
      payload: { kind: "final", result: "done" },
    });

    const updated = store.updateRunStepsMessageId("s1", "run-1", assistant.id);
    const steps = store.listRunSteps({ messageId: assistant.id, sessionId: "s1" });

    expect(first.step_order).toBe(1);
    expect(second.step_order).toBe(2);
    expect(updated).toBe(2);
    expect(steps.map((step) => step.payload.kind)).toEqual(["tool", "final"]);
    store.close();
  });

  it("persists runs, resources, and step resource links like Python", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-ts-store-"));
    const store = new ConversationStore({
      dbPath: path.join(root, "conversation.db"),
      dataRoot: path.join(root, "data"),
    });
    try {
      store.createSession("session-1", "user-1");
      const run = store.createRun({
        runId: "run-1",
        sessionId: "session-1",
        entrypoint: "execute",
        status: "running",
        taskSummary: "demo task",
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
      expect(runs.items[0]).toMatchObject({ status: "completed", final_message_id: message.id });
      expect(resources.items[0]).toMatchObject({ resource_id: resource.resource_id, source_tool: "write_file" });
      expect(steps[0]?.payload.resource_refs).toEqual([{ resource_id: resource.resource_id }]);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports child-scoped messages and run metadata", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    try {
      store.createSession("session-thread", "user-1");
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
    const store = new ConversationStore({
      dbPath: path.join(root, "conversation.db"),
      dataRoot,
    });
    try {
      const sessionId = "session-scope";
      const runId = "run-1";
      const workspaceRoot = path.join(root, "workspace");
      store.createSession(sessionId, null, { workspace_root: workspaceRoot });

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
