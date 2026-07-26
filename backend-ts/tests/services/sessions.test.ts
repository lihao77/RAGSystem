import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentSessionApplication } from "../../src/services/sessions/index.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { LocalAgentSessionRepository } from "../../src/adapters/local/local-agent-session-repository.js";
import { TransientArtifactService } from "../../src/services/artifacts/transient-artifact-service.js";
import fs from "node:fs";
import os from "node:os";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { createTenantId } from "../../src/identity/types.js";

const dataRoot = path.resolve(".test-data");

function createStore() {
  return createConversationStore({ dbPath: ":memory:", dataRoot });
}

function createApplication(store: ReturnType<typeof createStore>, transientArtifacts?: TransientArtifactService) {
  return new AgentSessionApplication(new LocalAgentSessionRepository(store), null, transientArtifacts ?? null);
}

describe("AgentSessionApplication", () => {
  it("写入 tenant_id 并按租户列出会话", async () => {
    const store = createStore();
    const app = createApplication(store);
    const otherTenantId = createTenantId("tnt_other");
    await app.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "local-session", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    await app.createSession({ tenantId: otherTenantId, sessionId: "other-session", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });

    expect((await app.getSession("local-session"))?.tenant_id).toBe(LOCAL_TENANT_ID);
    expect((await app.listSessions({ tenantId: LOCAL_TENANT_ID, access: { userId: "usr_local", includeTenant: true }, limit: 20 })).items.map((session) => session.session_id)).toEqual(["local-session"]);
    expect((await app.listSessions({ tenantId: otherTenantId, access: { userId: "usr_local", includeTenant: true }, limit: 20 })).items.map((session) => session.session_id)).toEqual(["other-session"]);
    store.close();
  });

  it("rejects unsafe session IDs before creating database or filesystem state", async () => {
    const store = createStore();
    const app = createApplication(store);
    await expect(app.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "../../outside", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null })).rejects.toThrow("session_id");
    expect(store.getSession("../../outside")).toBeNull();
    store.close();
  });

  it("removes managed session files after the database session is deleted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-session-delete-"));
    try {
      const store = createStore();
      const app = createApplication(store, new TransientArtifactService(root));
      await app.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "s-delete", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
      const file = path.join(root, "sessions", "s-delete", "transient", "data.txt");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "data");

      expect(await app.deleteSession("s-delete")).toBe(true);
      expect(fs.existsSync(path.join(root, "sessions", "s-delete"))).toBe(false);
      store.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the full persisted session identity", async () => {
    const store = createStore();
    const app = createApplication(store);

    const created = await app.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "s1", ownerUserId: "u1", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null, metadata: { team: "  default  " } });

    expect(created).toMatchObject({
      session_id: "s1",
      tenant_id: LOCAL_TENANT_ID,
      owner_user_id: "u1",
      visibility: "private",
      origin_type: "direct",
      origin_id: null,
      origin_channel: "api",
      workspace_id: null,
      permission_mode: null,
      metadata: { team: "default" },
    });
    store.close();
  });

  it("rejects reserved identity fields in metadata and resolves first-class Workspace binding", async () => {
    const store = createStore();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-workspace-"));
    try {
      store.resolveLocalWorkspace({
        workspaceId: "workspace-1",
        tenantId: LOCAL_TENANT_ID,
        kind: "local",
        displayName: "workspace",
        rootPath: workspaceRoot,
        canonicalKey: workspaceRoot,
      });
      const app = new AgentSessionApplication(
        new LocalAgentSessionRepository(store),
        null,
        null,
        async (session) => session.workspace_id
          ? store.getWorkspaceById(session.tenant_id, session.workspace_id)?.root_path ?? null
          : null,
      );
      const created = await app.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "s-workspace", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: "workspace-1", metadata: { entry_agent: "  orchestrator  " } });

      expect(created.workspace_id).toBe("workspace-1");
      expect(created.metadata).toEqual({ entry_agent: "orchestrator" });
      await expect(app.resolveWorkspaceRoot("s-workspace")).resolves.toBe(workspaceRoot);
      await expect(
        app.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "s-invalid", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null, metadata: { workspace_root: workspaceRoot } }),
      ).rejects.toThrow("metadata.workspace_root 是保留字段");
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      store.close();
    }
  });

  it("filters hidden, intermediate, child, and non-root messages like Python", async () => {
    const store = createStore();
    const app = createApplication(store);
    await app.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "s1", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    await app.addMessage({ sessionId: "s1", role: "user", content: "visible" });
    await app.addMessage({ sessionId: "s1", role: "assistant", content: "hidden", metadata: { visible_to_user: false } });
    await app.addMessage({ sessionId: "s1", role: "assistant", content: "react", metadata: { react_intermediate: true } });
    await app.addMessage({ sessionId: "s1", role: "assistant", content: "child", metadata: { conversation_scope: "child" } });
    await app.addMessage({ sessionId: "s1", role: "assistant", content: "thread", threadKey: "child:1" });
    await app.addMessage({ sessionId: "s1", role: "assistant", content: "answer", metadata: { run_id: "run-1" } });

    const listed = await app.listMessages({ sessionId: "s1", limit: 20, offset: 0 });

    expect(listed.items.map((item) => item.content)).toEqual(["visible", "answer"]);
    expect(listed.items[1]).toMatchObject({ has_execution: true });
    store.close();
  });
});
