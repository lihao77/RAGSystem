import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentSessionApplication } from "../../src/services/sessions/index.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { TransientArtifactService } from "../../src/services/artifacts/transient-artifact-service.js";
import fs from "node:fs";
import os from "node:os";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { createTenantId } from "../../src/identity/types.js";

const dataRoot = path.resolve(".test-data");

function createStore() {
  return createConversationStore({ dbPath: ":memory:", dataRoot });
}

describe("AgentSessionApplication", () => {
  it("写入 tenant_id 并按租户列出会话", () => {
    const store = createStore();
    const app = new AgentSessionApplication(store);
    const otherTenantId = createTenantId("tnt_other");
    app.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId: "local-session" });
    app.createSession({ tenantId: otherTenantId, userId: "usr_local", sessionId: "other-session" });

    expect(app.getSession("local-session")?.tenant_id).toBe(LOCAL_TENANT_ID);
    expect(app.listSessions({ tenantId: LOCAL_TENANT_ID }).items.map((session) => session.session_id)).toEqual(["local-session"]);
    expect(app.listSessions({ tenantId: otherTenantId }).items.map((session) => session.session_id)).toEqual(["other-session"]);
    store.close();
  });

  it("rejects unsafe session IDs before creating database or filesystem state", () => {
    const store = createStore();
    const app = new AgentSessionApplication(store);
    expect(() => app.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId: "../../outside" })).toThrow("session_id");
    expect(store.getSession("../../outside")).toBeNull();
    store.close();
  });

  it("removes managed session files after the database session is deleted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-session-delete-"));
    try {
      const store = createStore();
      const app = new AgentSessionApplication(store, null, new TransientArtifactService(root));
      app.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId: "s-delete" });
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

  it("returns the compact create_session payload with persisted permission mode", () => {
    const store = createStore();
    const app = new AgentSessionApplication(store);

    const created = app.createSession({ tenantId: LOCAL_TENANT_ID,
      sessionId: "s1",
      userId: "u1",
      metadata: { team: "  default  " },
    });

    expect(created).toEqual({
      session_id: "s1",
      user_id: "u1",
      permission_mode: null,
      metadata: { team: "default" },
    });
    store.close();
  });

  it("normalizes Python-compatible session runtime metadata", () => {
    const store = createStore();
    const app = new AgentSessionApplication(store);
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-workspace-"));
    try {
      const created = app.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local",
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
        app.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local",
          sessionId: "s-invalid",
          metadata: { workspace_root: "relative/path" },
        }),
      ).toThrow("metadata.workspace_root 必须是绝对路径");
      expect(() =>
        app.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local",
          sessionId: "s-missing-workspace",
          metadata: { workspace_root: path.join(workspaceRoot, "missing") },
        }),
      ).toThrow("metadata.workspace_root 必须是已存在的目录");
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      store.close();
    }
  });

  it("filters hidden, intermediate, child, and non-root messages like Python", () => {
    const store = createStore();
    const app = new AgentSessionApplication(store);
    app.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId: "s1" });
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
