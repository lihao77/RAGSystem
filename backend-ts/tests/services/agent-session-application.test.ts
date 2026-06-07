import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentSessionApplication } from "../../src/services/agent/agent-session-application.js";
import { ConversationStore } from "../../src/services/stores/conversation-store.js";

describe("AgentSessionApplication", () => {
  it("returns the same compact create_session payload as Python", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    const app = new AgentSessionApplication(store);

    const created = app.createSession({
      sessionId: "s1",
      userId: "u1",
      metadata: { team: "  default  " },
    });

    expect(created).toEqual({
      session_id: "s1",
      user_id: "u1",
      metadata: { team: "default" },
    });
    store.close();
  });

  it("normalizes Python-compatible session runtime metadata", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    const app = new AgentSessionApplication(store);
    const workspaceRoot = path.resolve("workspace-demo");

    const created = app.createSession({
      sessionId: "s-meta",
      metadata: {
        team: "  ",
        entry_agent: "  orchestrator  ",
        workspace_root: `\"${workspaceRoot}\"`,
      },
    });

    expect(created.metadata).toEqual({
      entry_agent: "orchestrator",
      workspace_root: workspaceRoot,
    });
    expect(() =>
      app.createSession({
        sessionId: "s-invalid",
        metadata: { workspace_root: "relative/path" },
      }),
    ).toThrow("metadata.workspace_root 必须是绝对路径");
    store.close();
  });

  it("filters hidden, intermediate, child, and non-root messages like Python", () => {
    const store = new ConversationStore({ dbPath: ":memory:" });
    const app = new AgentSessionApplication(store);
    app.createSession({ sessionId: "s1" });
    app.addMessage({ sessionId: "s1", role: "user", content: "visible" });
    app.addMessage({ sessionId: "s1", role: "assistant", content: "hidden", metadata: { visible_to_user: false } });
    app.addMessage({ sessionId: "s1", role: "assistant", content: "react", metadata: { react_intermediate: true } });
    app.addMessage({ sessionId: "s1", role: "assistant", content: "child", metadata: { conversation_scope: "child" } });
    app.addMessage({ sessionId: "s1", role: "assistant", content: "thread", threadKey: "child:1" });
    app.addMessage({ sessionId: "s1", role: "assistant", content: "answer", metadata: { run_id: "run-1" } });

    const listed = app.listMessages({ sessionId: "s1", limit: 20, offset: 0 });

    expect(listed.items.map((item) => item.content)).toEqual(["visible", "answer"]);
    expect(listed.items[1]).toMatchObject({ has_execution: true });
    store.close();
  });
});
