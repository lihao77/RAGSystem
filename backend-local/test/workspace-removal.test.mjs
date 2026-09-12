import assert from "node:assert/strict";
import test from "node:test";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";

const agents = { orchestrator_agent: { agent_name: "orchestrator_agent" } };
const teamSnapshot = { team_name: "test", team_revision: computeSessionTeamRevision(agents), entry_agent_name: "orchestrator_agent", agents };

function seedWorkspaceWithSession(store, { workspaceId, sessionId }) {
  const workspace = store.resolveLocalWorkspace({
    workspaceId,
    tenantId: "tnt_test",
    kind: "local",
    displayName: "ragsystem",
    rootPath: "D:/python/ragsystem",
    canonicalKey: "d:/python/ragsystem",
  });
  store.createSession({
    tenantId: "tnt_test",
    sessionId,
    ownerUserId: "usr_test",
    visibility: "private",
    originType: "direct",
    originId: null,
    originChannel: "web",
    workspaceId: workspace.workspace_id,
    teamSnapshot,
    metadata: {},
    permissionMode: null,
  });
  return workspace;
}

test("removing and re-adding a workspace preserves its sessions and identity", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    const workspace = seedWorkspaceWithSession(store, { workspaceId: "workspace-1", sessionId: "session-1" });

    assert.equal(store.removeWorkspace("tnt_test", workspace.workspace_id), true);
    assert.deepEqual(store.listAllWorkspaces("tnt_test"), []);
    // 会话保持与项目的绑定，不会归入未归属
    assert.equal(store.getSession("session-1")?.workspace_id, workspace.workspace_id);
    assert.equal(store.getSessionListProjection("session-1")?.workspace_id, workspace.workspace_id);
    assert.equal(store.listWorkspacesByIds("tnt_test", [workspace.workspace_id])[0]?.display_name, "ragsystem");

    // 重新添加同一文件夹：原项目复活，会话自动归队
    const restored = store.resolveLocalWorkspace({
      workspaceId: "workspace-new-id",
      tenantId: "tnt_test",
      kind: "local",
      displayName: "ragsystem",
      rootPath: "D:/python/ragsystem",
      canonicalKey: "d:/python/ragsystem",
    });
    assert.equal(restored.workspace_id, workspace.workspace_id);
    assert.equal(restored.removed_at, null);
    assert.equal(store.listAllWorkspaces("tnt_test")[0]?.workspace_id, workspace.workspace_id);
    assert.equal(store.getSession("session-1")?.workspace_id, workspace.workspace_id);
  } finally {
    store.close();
  }
});

test("removing an empty workspace deletes it permanently", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    const workspace = store.resolveLocalWorkspace({
      workspaceId: "workspace-empty",
      tenantId: "tnt_test",
      kind: "local",
      displayName: "empty",
      rootPath: "D:/empty",
      canonicalKey: "d:/empty",
    });

    assert.equal(store.removeWorkspace("tnt_test", workspace.workspace_id), true);
    assert.equal(store.getWorkspaceById("tnt_test", workspace.workspace_id), null);
    assert.equal(store.getWorkspaceByCanonicalKey("tnt_test", "d:/empty"), null);
    assert.equal(store.removeWorkspace("tnt_test", workspace.workspace_id), false);

    const recreated = store.resolveLocalWorkspace({
      workspaceId: "workspace-recreated",
      tenantId: "tnt_test",
      kind: "local",
      displayName: "empty",
      rootPath: "D:/empty",
      canonicalKey: "d:/empty",
    });
    assert.equal(recreated.workspace_id, "workspace-recreated");
  } finally {
    store.close();
  }
});

test("renaming a workspace updates the display name without touching the path", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    const workspace = seedWorkspaceWithSession(store, { workspaceId: "workspace-rename", sessionId: "session-rename" });

    const renamed = store.renameWorkspace("tnt_test", workspace.workspace_id, "新名称");
    assert.equal(renamed?.display_name, "新名称");
    assert.equal(renamed?.root_path, workspace.root_path);
    assert.equal(renamed?.canonical_key, workspace.canonical_key);
    assert.equal(store.getWorkspaceById("tnt_test", workspace.workspace_id)?.display_name, "新名称");
    // 会话绑定不受重命名影响
    assert.equal(store.getSession("session-rename")?.workspace_id, workspace.workspace_id);

    assert.equal(store.renameWorkspace("tnt_test", "workspace-missing", "whatever"), null);

    // 软删项目（有会话时的移除形态）不可重命名
    assert.equal(store.removeWorkspace("tnt_test", workspace.workspace_id), true);
    assert.equal(store.renameWorkspace("tnt_test", workspace.workspace_id, "再改名"), null);
  } finally {
    store.close();
  }
});
