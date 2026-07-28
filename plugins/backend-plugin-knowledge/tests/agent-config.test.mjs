import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { KnowledgeAgentConfigService } from "../dist/agent-config.js";
import { SqliteKnowledgeAgentConfigStore } from "../dist/storage/local/agent-config-store.js";
import { createKnowledgeTools } from "../dist/tools/KnowledgeTools.js";

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

test("knowledge config is isolated per team and delete restores defaults", async () => {
  const service = new KnowledgeAgentConfigService(new MemoryStore());
  const first = { teamName: "alpha", agentName: "writer" };
  const second = { teamName: "beta", agentName: "writer" };

  assert.equal((await service.getEffective(first)).enabled, false);
  await service.put(first, {
    enabled: true,
    default_collection: "product",
    default_search_mode: "vector",
    default_top_k: 8,
    default_rerank: false,
    default_reranker_key: null,
  });

  assert.equal((await service.getEffective(first)).default_collection, "product");
  assert.equal((await service.getEffective(second)).enabled, false);
  assert.equal((await service.delete(first)).enabled, false);
  assert.equal((await service.getEffective(first)).default_collection, "documents");
});

test("knowledge tools are exposed only when the plugin config enables them", () => {
  const knowledge = { search: async () => ({ results: [] }), listCollections: async () => [] };
  const disabled = createKnowledgeTools({ knowledge, config: {
    enabled: false,
    default_collection: "documents",
    default_search_mode: "hybrid",
    default_top_k: 5,
    default_rerank: false,
    default_reranker_key: null,
  } });
  const enabled = createKnowledgeTools({ knowledge, config: {
    enabled: true,
    default_collection: "documents",
    default_search_mode: "hybrid",
    default_top_k: 5,
    default_rerank: false,
    default_reranker_key: null,
  } });

  assert.deepEqual(disabled, []);
  assert.deepEqual(enabled.map((tool) => tool.name).sort(), ["list_knowledge_collections", "search_knowledge_base"]);
});

test("knowledge SQLite config store persists tenant-scoped overrides", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const alpha = new KnowledgeAgentConfigService(new SqliteKnowledgeAgentConfigStore(db, "alpha"));
    const beta = new KnowledgeAgentConfigService(new SqliteKnowledgeAgentConfigStore(db, "beta"));
    const key = { teamName: "default", agentName: "writer" };
    await alpha.put(key, {
      enabled: true,
      default_collection: "alpha-docs",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    });
    assert.equal((await alpha.getEffective(key)).default_collection, "alpha-docs");
    assert.equal((await beta.getEffective(key)).default_collection, "documents");
  } finally {
    db.close();
  }
});
