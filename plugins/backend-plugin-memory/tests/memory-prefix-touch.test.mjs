import assert from "node:assert/strict";
import test from "node:test";

import { MemoryContextSource } from "../dist/services/agent/memory/memory-context-source.js";

const memoryConfig = {
  enabled: true,
  auto_inject: true,
  allowed_scopes: ["session"],
  write_scopes: ["session"],
  archive_scopes: ["session"],
};

function fakeSessions(writes) {
  return {
    getSession: () => ({ metadata: {}, owner_user_id: null, workspace_id: null }),
    updateSessionMetadata: (_sessionId, patch) => {
      writes.push(patch);
      return {};
    },
  };
}

const repository = {
  resolveWorkspaceKey: async () => null,
  loadIndex: async () => "# memory index",
  getScopeRevision: async () => 1,
};

test("memory prefix snapshot persists only on touch builds", async () => {
  const writes = [];
  const source = new MemoryContextSource(
    fakeSessions(writes),
    repository,
    memoryConfig,
    "team-a",
    "agent-a",
    {},
  );
  const request = { sessionId: "session-1", threadKey: "root", cacheAlive: false, touch: false };

  // 只读组装（monitoring 预览等）：重建前缀块但不得写会话元数据。
  const readOnly = await source.build(request);
  assert.ok(readOnly.conversation.length > 0);
  assert.equal(writes.length, 0);

  // run 路径（touch=true）：重建并持久化快照，供缓存活期内的后续组装复用。
  await source.build({ ...request, touch: true });
  assert.equal(writes.length, 1);
  const baselines = Object.keys(writes[0].memory_prefix_states);
  assert.equal(baselines.length, 1);
});
