import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  vi.unstubAllGlobals();
});

describe("model adapter compatibility routes", () => {
  it("serves provider type metadata and an empty provider list by default", async () => {
    app = await buildTestApp();

    const types = await app.inject({
      method: "GET",
      url: "/api/model-adapter/provider-types",
    });
    expect(types.statusCode).toBe(200);
    expect(types.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "openai_resp",
          label: "OpenAI Responses",
          default_endpoint: "https://api.openai.com/v1",
        }),
        expect.objectContaining({
          value: "rerank_api",
          label: "Rerank API",
        }),
      ]),
    );
    const openAiResponses = types.json().data.find((item: { value: string }) => item.value === "openai_resp");
    expect(openAiResponses.config_fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "reasoning_effort", type: "select" }),
      expect.objectContaining({ key: "retry_attempts", type: "number" }),
    ]));

    const providers = await app.inject({
      method: "GET",
      url: "/api/model-adapter/providers",
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toMatchObject({
      success: true,
      data: [],
      providers: [],
    });
  });

  it("creates, updates, reorders, and deletes in-memory providers", async () => {
    app = await buildTestApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "My DeepSeek",
        provider_type: "deepseek",
        api_key: "sk-test",
        model_map: {
          chat: ["deepseek-chat", "deepseek-reasoner"],
          embedding: "deepseek-embed",
        },
        temperature: 0.2,
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      provider_key: "my_deepseek_deepseek",
      data: {
        provider_key: "my_deepseek_deepseek",
      },
    });

    const metrics = await app.inject({
      method: "GET",
      url: "/api/model-adapter/providers/my_deepseek_deepseek/metrics",
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().data).toEqual({
      provider_key: "my_deepseek_deepseek",
      resilience: null,
    });

    const aliased = await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "Main",
        provider_type: "openai",
        api_mode: "responses",
        api_key: "sk-openai",
        model: "gpt-4.1",
      },
    });
    expect(aliased.statusCode).toBe(200);
    expect(aliased.json().provider_key).toBe("main_openai_resp");

    const listed = await app.inject({
      method: "GET",
      url: "/api/model-adapter/providers",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().providers).toMatchObject([
      {
        key: "my_deepseek_deepseek",
        name: "My DeepSeek",
        provider_type: "deepseek",
        models: ["deepseek-chat", "deepseek-reasoner", "deepseek-embed"],
        model_map: {
          chat: ["deepseek-chat", "deepseek-reasoner"],
          embedding: "deepseek-embed",
        },
        is_loaded: true,
      },
      {
        key: "main_openai_resp",
        provider_type: "openai_resp",
        models: ["gpt-4.1"],
        model_map: {
          chat: "gpt-4.1",
        },
      },
    ]);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/model-adapter/providers/my_deepseek_deepseek",
      payload: {
        api_key: "",
        provider_type: "deepseek",
        model_map: {
          chat: "deepseek-chat",
        },
        max_context_tokens: 64000,
      },
    });
    expect(updated.statusCode).toBe(200);

    const afterUpdate = await app.inject({
      method: "GET",
      url: "/api/model-adapter/providers",
    });
    const first = afterUpdate.json().providers[0];
    expect(first).toMatchObject({
      key: "my_deepseek_deepseek",
      api_key_configured: true,
      max_context_tokens: 64000,
      models: ["deepseek-chat"],
      model_map: {
        chat: "deepseek-chat",
      },
    });
    expect(first).not.toHaveProperty("api_key");

    const reordered = await app.inject({
      method: "PUT",
      url: "/api/model-adapter/providers/order",
      payload: {
        provider_keys: ["main_openai_resp", "my_deepseek_deepseek"],
      },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().provider_keys).toEqual(["main_openai_resp", "my_deepseek_deepseek"]);

    const afterReorder = await app.inject({
      method: "GET",
      url: "/api/model-adapter/providers",
    });
    expect(afterReorder.json().providers.map((provider: { key: string }) => provider.key)).toEqual([
      "main_openai_resp",
      "my_deepseek_deepseek",
    ]);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/model-adapter/providers/my_deepseek_deepseek",
    });
    expect(deleted.statusCode).toBe(200);

    const afterDelete = await app.inject({
      method: "GET",
      url: "/api/model-adapter/providers",
    });
    expect(afterDelete.json().providers.map((provider: { key: string }) => provider.key)).toEqual([
      "main_openai_resp",
    ]);
  });

  it("validates provider shape and duplicate keys", async () => {
    app = await buildTestApp();

    const invalidModelMap = await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "Bad",
        provider_type: "deepseek",
        api_key: "sk-test",
        model_map: [],
      },
    });
    expect(invalidModelMap.statusCode).toBe(400);
    expect(invalidModelMap.json()).toMatchObject({
      success: false,
      message: "model_map 必须是对象",
    });

    const unsupportedType = await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "Unknown",
        provider_type: "local_llm",
        api_key: "sk-test",
        model: "local-model",
      },
    });
    expect(unsupportedType.statusCode).toBe(400);
    expect(unsupportedType.json()).toMatchObject({
      success: false,
      message: "不支持的 Provider 类型: local_llm",
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "Dup",
        provider_type: "deepseek",
        api_key: "sk-test",
        model: "deepseek-chat",
      },
    });
    expect(first.statusCode).toBe(200);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "Dup",
        provider_type: "deepseek",
        api_key: "sk-test-2",
        model: "deepseek-chat",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      success: false,
      message: "Provider 已存在: dup_deepseek",
    });

    const badOrder = await app.inject({
      method: "PUT",
      url: "/api/model-adapter/providers/order",
      payload: {
        provider_keys: ["missing_deepseek"],
      },
    });
    expect(badOrder.statusCode).toBe(400);
    expect(badOrder.json().message).toContain("缺少 Provider: dup_deepseek");
    expect(badOrder.json().message).toContain("未知 Provider: missing_deepseek");
  });

  it("reports provider usages and blocks deletion while an agent still references it", async () => {
    app = await buildTestApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "my",
        provider_type: "deepseek",
        api_key: "sk-test",
        model_map: { chat: "deepseek-chat" },
      },
    });
    expect(created.statusCode).toBe(200);

    const usages = await app.inject({
      method: "GET",
      url: "/api/model-adapter/providers/my_deepseek/usages",
    });
    expect(usages.statusCode).toBe(200);
    expect(usages.json().usages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "agent", detail: expect.stringContaining("模型档位") }),
    ]));

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/model-adapter/providers/my_deepseek",
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toMatchObject({
      success: false,
      code: "provider_in_use",
    });
  });

  it("checks provider availability and runs embedding/rerank tests", async () => {
    app = await buildTestApp();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/embeddings")) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.1 },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: `unexpected URL: ${url}` }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await app.inject({
      method: "POST",
      url: "/api/model-adapter/providers",
      payload: {
        name: "Test",
        provider_type: "deepseek",
        api_key: "sk-test",
        api_endpoint: "https://provider.example.test/v1",
        model_map: {
          chat: "deepseek-chat",
          embedding: "embed-model",
          rerank: "rerank-model",
        },
      },
    });

    const check = await app.inject({
      method: "GET",
      url: "/api/model-adapter/providers/test_deepseek/check",
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({
      success: true,
      message: "检查成功",
      provider_key: "test_deepseek",
      is_available: true,
      data: {
        provider_key: "test_deepseek",
        is_available: true,
        checks: {
          api_key_configured: true,
          chat_model_configured: true,
          embedding_model_configured: true,
          rerank_model_configured: true,
        },
        error: null,
      },
    });

    const invalidTest = await app.inject({
      method: "POST",
      url: "/api/model-adapter/test",
      payload: {
        provider: "Test",
        model: "deepseek-chat",
      },
    });
    expect(invalidTest.statusCode).toBe(400);
    expect(invalidTest.json().message).toBe("请提供测试内容");

    const embedding = await app.inject({
      method: "POST",
      url: "/api/model-adapter/test",
      payload: {
        provider: "Test",
        provider_type: "deepseek",
        model: "embed-model",
        prompt: "Hi",
        task: "embedding",
      },
    });
    expect(embedding.statusCode).toBe(200);
    expect(embedding.json().response).toMatchObject({
      error: null,
      model: "embed-model",
      provider: "Test",
      embeddings: [[0.1, 0.2, 0.3]],
    });

    const rerank = await app.inject({
      method: "POST",
      url: "/api/model-adapter/test",
      payload: {
        provider: "Test",
        provider_type: "deepseek",
        model: "rerank-model",
        prompt: "Hi",
        task: "rerank",
        documents: [{ id: "d1", text: "Hi" }, { id: "d2", text: "Other" }],
      },
    });
    expect(rerank.statusCode).toBe(200);
    expect(rerank.json().response).toMatchObject({
      error: null,
      model: "rerank-model",
      provider: "Test",
      results: [
        { id: "d1", score: 0.9 },
        { id: "d2", score: 0.1 },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
