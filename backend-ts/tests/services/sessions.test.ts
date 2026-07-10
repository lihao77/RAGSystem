import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentSessionApplication } from "../../src/services/sessions/index.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { TransientArtifactService } from "../../src/services/artifacts/transient-artifact-service.js";
import fs from "node:fs";
import os from "node:os";

describe("AgentSessionApplication", () => {
  it("rejects unsafe session IDs before creating database or filesystem state", () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    const app = new AgentSessionApplication(store);
    expect(() => app.createSession({ sessionId: "../../outside" })).toThrow("session_id");
    expect(store.getSession("../../outside")).toBeNull();
    store.close();
  });

  it("removes managed session files after the database session is deleted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-session-delete-"));
    try {
      const store = createConversationStore({ dbPath: ":memory:" });
      const app = new AgentSessionApplication(store, null, new TransientArtifactService(root));
      app.createSession({ sessionId: "s-delete" });
      const file = path.join(root, "sessions", "s-delete", "transient", "data.txt");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "data");

      expect(app.deleteSession("s-delete")).toBe(true);
      expect(fs.existsSync(path.join(root, "sessions", "s-delete"))).toBe(false);
      store.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the same compact create_session payload as Python", () => {
    const store = createConversationStore({ dbPath: ":memory:" });
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
    const store = createConversationStore({ dbPath: ":memory:" });
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
    const store = createConversationStore({ dbPath: ":memory:" });
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
