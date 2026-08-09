import assert from "node:assert/strict";
import test from "node:test";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";
import { computeSessionTeamRevision } from "@ragsystem/backend-core/contracts/session/session.js";

const agents = { orchestrator_agent: { agent_name: "orchestrator_agent" } };
const teamSnapshot = { team_name: "test", team_revision: computeSessionTeamRevision(agents), entry_agent_name: "orchestrator_agent", agents };

test("removing and re-adding a workspace preserves its sessions and identity", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    const workspace = store.resolveLocalWorkspace({
      workspaceId: "workspace-1",
      tenantId: "tnt_test",
      kind: "local",
      displayName: "ragsystem",
      rootPath: "D:/python/ragsystem",
      canonicalKey: "d:/python/ragsystem",
    });
    store.createSession({
      tenantId: "tnt_test",
      sessionId: "session-1",
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

    assert.equal(store.removeWorkspace("tnt_test", workspace.workspace_id), true);
    assert.deepEqual(store.listAllWorkspaces("tnt_test"), []);
    assert.equal(store.getSession("session-1")?.workspace_id, workspace.workspace_id);
    assert.equal(store.listWorkspacesByIds("tnt_test", [workspace.workspace_id])[0]?.display_name, "ragsystem");

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
