import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { MemoryAgentConfigService } from "../dist/config.js";
import { SqliteMemoryAgentConfigStore } from "../dist/storage/local/agent-config-store.js";
import { createMemoryTools } from "../dist/tools/MemoryTools.js";

class MemoryStore {
  values = new Map();

  key({ teamName, agentName }) {
    return `${teamName}/${agentName}`;
  }

  async get(key) {
    return this.values.get(this.key(key)) ?? null;
  }

  async put(key, config) {
    this.values.set(this.key(key), structuredClone(config));
  }

  async delete(key) {
    return this.values.delete(this.key(key));
  }
}

const agent = { agent_name: "writer" };
const operations = {};

test("memory config is isolated per team and delete restores defaults", async () => {
  const service = new MemoryAgentConfigService(new MemoryStore());
  const first = { teamName: "alpha", agentName: "writer" };
  const second = { teamName: "beta", agentName: "writer" };

  assert.equal((await service.getEffective(first)).enabled, true);
  await service.put(first, {
    enabled: false,
    auto_inject: false,
    allowed_scopes: [],
    write_scopes: [],
    archive_scopes: [],
  });

  assert.equal((await service.getEffective(first)).enabled, false);
  assert.equal((await service.getEffective(second)).enabled, true);
  assert.equal((await service.delete(first)).enabled, true);
});

test("memory tools are exposed only when the plugin config enables them", () => {
  const disabled = createMemoryTools({ agent, memoryTools: operations, config: {
    enabled: false,
    auto_inject: true,
    allowed_scopes: ["team"],
    write_scopes: ["session"],
    archive_scopes: ["session"],
  } });
  const enabled = createMemoryTools({ agent, memoryTools: operations, config: {
    enabled: true,
    auto_inject: true,
    allowed_scopes: ["team"],
    write_scopes: ["session"],
    archive_scopes: ["session"],
  } });

  assert.deepEqual(disabled, []);
  assert.deepEqual(enabled.map((tool) => tool.name).sort(), [
    "archive_memory",
    "list_memory_index",
    "read_memory_entry",
    "write_memory",
  ]);
});

test("memory SQLite config store persists tenant-scoped overrides", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const alpha = new MemoryAgentConfigService(new SqliteMemoryAgentConfigStore(db, "alpha"));
    const beta = new MemoryAgentConfigService(new SqliteMemoryAgentConfigStore(db, "beta"));
    const key = { teamName: "default", agentName: "writer" };
    await alpha.put(key, {
      enabled: false,
      auto_inject: false,
      allowed_scopes: [],
      write_scopes: [],
      archive_scopes: [],
    });
    assert.equal((await alpha.getEffective(key)).enabled, false);
    assert.equal((await beta.getEffective(key)).enabled, true);
  } finally {
    db.close();
  }
});
