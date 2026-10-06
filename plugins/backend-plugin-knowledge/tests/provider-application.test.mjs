import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";

import { registerKnowledgeBaseRoutes } from "../dist/routes.js";
import { createEmbedder } from "../dist/services/integrations/embedder-registry.js";
import { KnowledgeApplicationService } from "../dist/services/knowledge/knowledge-application-service.js";
import { KnowledgeHttpApplication } from "../dist/services/knowledge/knowledge-http-application.js";
import { SqliteKnowledgeModelProviderStore } from "../dist/storage/local/model-provider-store.js";

const providerFixture = {
  provider_key: "fixture",
  kind: "embedding",
  name: "Fixture embedding",
  api_endpoint: "https://old.example.invalid/v1",
  api_key: "FAKE_OLD_KEY",
  model_name: "fixture-model",
  is_active: true,
};

function harness(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const providers = new SqliteKnowledgeModelProviderStore(db);
  const vectorizer = {
    vectorizer_key: "fixture-vectorizer",
    provider_key: "fixture",
    model_name: "fixture-model",
    model_id: 1,
    provider_type: "embedding",
    distance_metric: "cosine",
    created_at: "2026-01-01",
    vector_dimension: null,
    is_active: true,
  };
  const config = {
    listVectorizers: async () => [{ ...vectorizer }],
    listRerankers: async () => [],
  };
  const vectors = { search: async () => [] };
  const calls = [];
  const creations = [];
  const client = {
    embed: async ({ provider, model }) => {
      calls.push({ endpoint: provider.api_endpoint, apiKey: provider.api_key, model });
      return [[1, 0]];
    },
  };
  const factory = (provider, model) => {
    creations.push({ provider, model });
    return createEmbedder(provider, model, client);
  };
  const createService = () => new KnowledgeApplicationService("test-tenant", providers, config, vectors, factory);
  return { providers, vectorizer, client, calls, creations, createService, service: createService() };
}

async function httpApp(t, service) {
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest("identity", null);
  app.decorateRequest("container", null);
  const application = new KnowledgeHttpApplication(service, {}, {});
  app.addHook("onRequest", async (request) => {
    request.identity = { role: request.headers["x-test-role"] ?? "member", tenantId: "test-tenant" };
    request.container = { pluginCapabilities: { require: () => ({ application }) } };
  });
  await app.register(registerKnowledgeBaseRoutes, { prefix: "/api/knowledge-bases" });
  return app;
}

function assertPublicProvider(info, expected, configured = true) {
  assert.equal(Object.hasOwn(info, "api_key"), false);
  assert.equal(info.api_key_configured, configured);
  for (const field of ["provider_key", "kind", "name", "api_endpoint", "model_name", "is_active"]) {
    assert.equal(info[field], expected[field]);
  }
  assert.deepEqual(Object.keys(info).sort(), [
    "provider_key", "kind", "name", "api_endpoint", "model_name", "is_active", "created_at", "api_key_configured",
  ].sort());
}

test("member Provider lists expose metadata without embedding or rerank credentials", async (t) => {
  const { providers, service } = harness(t);
  await providers.upsertProvider("test-tenant", providerFixture);
  const rerank = { ...providerFixture, provider_key: "rerank", kind: "rerank", api_key: "FAKE_RERANK_KEY" };
  await providers.upsertProvider("test-tenant", rerank);
  const app = await httpApp(t, service);
  const response = await app.inject({ method: "GET", url: "/api/knowledge-bases/model-providers" });
  assert.equal(response.statusCode, 200);
  const listed = response.json().data;
  assert.equal(listed.length, 2);
  assertPublicProvider(listed.find((item) => item.provider_key === "fixture"), providerFixture);
  assertPublicProvider(listed.find((item) => item.provider_key === "rerank"), rerank);
  assert.equal(response.body.includes("FAKE_OLD_KEY"), false);
  assert.equal(response.body.includes("FAKE_RERANK_KEY"), false);
  const filtered = await app.inject({ method: "GET", url: "/api/knowledge-bases/model-providers?kind=rerank" });
  assert.equal(filtered.statusCode, 200);
  assert.equal(filtered.json().data.length, 1);
  assertPublicProvider(filtered.json().data[0], rerank);
});

test("Provider saves never echo credentials and preserve blank-key updates", async (t) => {
  const { providers, service } = harness(t);
  const app = await httpApp(t, service);
  for (const apiKey of ["FAKE_OLD_KEY", "", "FAKE_ROTATED_KEY"]) {
    const response = await app.inject({
      method: "POST", url: "/api/knowledge-bases/model-providers",
      headers: { "x-test-role": "admin" }, payload: { ...providerFixture, api_key: apiKey },
    });
    assert.equal(response.statusCode, 200);
    assertPublicProvider(response.json().data, providerFixture);
    assert.equal(response.body.includes("FAKE_"), false);
    assert.equal((await providers.getProvider("test-tenant", "fixture")).api_key, apiKey || "FAKE_OLD_KEY");
  }
  const noKey = { ...providerFixture, provider_key: "no-key", api_key: "" };
  const created = await service.upsertModelProvider(noKey);
  assertPublicProvider(created, noKey, false);
  const denied = await app.inject({ method: "POST", url: "/api/knowledge-bases/model-providers", payload: providerFixture });
  assert.equal(denied.statusCode, 403);
});

test("embedding cache reuses unchanged config and refreshes updated credentials and endpoint", async (t) => {
  const { providers, service, calls, creations } = harness(t);
  await providers.upsertProvider("test-tenant", providerFixture);
  const query = { query: "fixture", search_mode: "vector" };
  await service.search(query);
  await service.search(query);
  assert.equal(creations.length, 1);
  await service.upsertModelProvider({ ...providerFixture, api_endpoint: "https://new.example.invalid/v1", api_key: "FAKE_NEW_KEY" });
  await service.search(query);
  assert.deepEqual(calls.at(-1), { endpoint: "https://new.example.invalid/v1", apiKey: "FAKE_NEW_KEY", model: "fixture-model" });
  assert.equal(creations.length, 2);
  await service.upsertModelProvider({ ...providerFixture, api_endpoint: "https://new.example.invalid/v1", api_key: "" });
  await service.search(query);
  assert.equal(creations.length, 2);
  assert.equal(calls.at(-1).apiKey, "FAKE_NEW_KEY");
});

test("embedding cache detects updates from another application sharing the store", async (t) => {
  const { providers, service, createService, calls, creations, vectorizer } = harness(t);
  await providers.upsertProvider("test-tenant", providerFixture);
  const other = createService();
  const query = { query: "fixture", search_mode: "vector" };
  await service.search(query);
  await other.search(query);
  await other.upsertModelProvider({ ...providerFixture, api_key: "FAKE_SHARED_KEY" });
  await service.search(query);
  assert.equal(calls.at(-1).apiKey, "FAKE_SHARED_KEY");
  assert.equal(creations.length, 3);
  vectorizer.model_name = "new-vectorizer-model";
  await service.search(query);
  assert.equal(calls.at(-1).model, "new-vectorizer-model");
  assert.equal(creations.length, 4);
});

test("embedding cache converges after a missing Provider is restored", async (t) => {
  const { providers, service, creations, calls } = harness(t);
  const query = { query: "fixture", search_mode: "vector" };
  await service.search(query);
  assert.equal(creations.at(-1).provider, null);
  await providers.upsertProvider("test-tenant", providerFixture);
  await service.search(query);
  assert.equal(calls.at(-1).apiKey, "FAKE_OLD_KEY");
  await providers.deleteProvider("test-tenant", "fixture");
  await service.search(query);
  assert.equal(creations.at(-1).provider, null);
  assert.equal(creations.length, 3);
});

test("concurrent searches reuse the new client while an old-config request finishes", async (t) => {
  const { providers, service, client, calls, creations } = harness(t);
  await providers.upsertProvider("test-tenant", providerFixture);
  let startOld;
  let finishOld;
  const started = new Promise((resolve) => { startOld = resolve; });
  const blocked = new Promise((resolve) => { finishOld = resolve; });
  const embed = client.embed;
  client.embed = async (request) => {
    const result = await embed(request);
    if (request.provider.api_key === "FAKE_OLD_KEY") {
      startOld();
      await blocked;
    }
    return result;
  };
  const query = { query: "fixture", search_mode: "vector" };
  const oldSearch = service.search(query);
  await started;
  try {
    await service.upsertModelProvider({ ...providerFixture, api_key: "FAKE_CONCURRENT_KEY" });
    await Promise.all([service.search(query), service.search(query)]);
  } finally {
    finishOld();
    await oldSearch;
  }
  assert.deepEqual(calls.map((call) => call.apiKey), ["FAKE_OLD_KEY", "FAKE_CONCURRENT_KEY", "FAKE_CONCURRENT_KEY"]);
  assert.equal(creations.length, 2);
  await service.search(query);
  assert.equal(calls.at(-1).apiKey, "FAKE_CONCURRENT_KEY");
  assert.equal(creations.length, 2);
});
