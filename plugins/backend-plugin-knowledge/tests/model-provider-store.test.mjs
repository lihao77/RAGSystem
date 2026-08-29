import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

import { SqliteKnowledgeModelProviderStore } from "../dist/storage/local/model-provider-store.js";
import { POSTGRES_KNOWLEDGE_CONFIG_MIGRATIONS } from "../dist/storage/postgres/knowledge-config-schema.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

function makeStore() {
  return new SqliteKnowledgeModelProviderStore(new DatabaseSync(":memory:"));
}

test("自管 Provider 存储：CRUD + keepExistingApiKey 语义", async () => {
  const store = makeStore();
  const created = await store.upsertProvider("t1", {
    provider_key: "bce",
    kind: "embedding",
    name: "百度千帆 BCE",
    api_endpoint: "https://bce.example.com/v1",
    api_key: "sk-1",
    model_name: "bce-embedding-v1",
    is_active: true,
  });
  assert.equal(created.provider_key, "bce");
  assert.equal(created.api_key, "sk-1");

  // 覆盖更新：api_key 留空 → 保留原值
  const updated = await store.upsertProvider("t1", { ...created, api_key: "" }, { keepExistingApiKey: true });
  assert.equal(updated.api_key, "sk-1");
  assert.equal(updated.api_endpoint, "https://bce.example.com/v1");

  // 显式传新值则覆盖
  const rotated = await store.upsertProvider("t1", { ...created, api_key: "sk-2" });
  assert.equal(rotated.api_key, "sk-2");

  assert.equal((await store.getProvider("t1", "bce"))?.kind, "embedding");
  assert.equal(await store.getProvider("t1", "missing"), null);

  const rerank = await store.upsertProvider("t1", {
    provider_key: "jina", kind: "rerank", name: "Jina", api_endpoint: "https://api.jina.ai/v1",
    api_key: "sk-j", model_name: "jina-reranker-v2", is_active: true,
  });
  const all = await store.listProviders("t1");
  assert.equal(all.length, 2);
  assert.ok(all.some((provider) => provider.provider_key === rerank.provider_key));

  await store.deleteProvider("t1", "bce");
  assert.equal(await store.getProvider("t1", "bce"), null);
});

test("Postgres 迁移含 knowledge_model_providers（v4）", () => {
  const v4 = POSTGRES_KNOWLEDGE_CONFIG_MIGRATIONS.find((migration) => migration.name === "knowledge_model_providers");
  assert.ok(v4);
  assert.ok(v4.sql.includes("CREATE TABLE IF NOT EXISTS knowledge_model_providers"));
  assert.ok(v4.sql.includes("CHECK (kind IN ('embedding', 'rerank'))"));
});
