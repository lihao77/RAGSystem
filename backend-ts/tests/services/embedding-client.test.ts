import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { OpenAiCompatibleEmbeddingClient } from "../../src/services/integrations/embedding-client.js";

/**
 * embedding-client 单测:验证 OpenAI 兼容 /embeddings 请求构造、响应解析、错误处理、${ENV_VAR} 占位符。
 * mock global fetch,不触网。
 */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const provider = (overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig => ({
  name: "p",
  provider_type: "openai_chat",
  models: [],
  model_map: {},
  api_key: "sk-test",
  api_endpoint: "https://api.openai.com/v1",
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAiCompatibleEmbeddingClient", () => {
  it("embed POST /embeddings 并按序解析 data[].embedding", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
    );
    const client = new OpenAiCompatibleEmbeddingClient();
    const vectors = await client.embed({ texts: ["a", "b"], model: "m", provider: provider() });
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/embeddings");
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ model: "m", input: ["a", "b"] });
  });

  it("api_key 支持 ${ENV_VAR} 占位符解析", async () => {
    process.env.TEST_EMBED_KEY = "resolved-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResponse({ data: [{ embedding: [0.1] }] }));
    try {
      const client = new OpenAiCompatibleEmbeddingClient();
      await client.embed({ texts: ["x"], model: "m", provider: provider({ api_key: "${TEST_EMBED_KEY}" }) });
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer resolved-key");
    } finally {
      delete process.env.TEST_EMBED_KEY;
    }
  });

  it("api_endpoint 支持 ${ENV_VAR} 占位符", async () => {
    process.env.TEST_EMBED_HOST = "https://embed.example.com/v1";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResponse({ data: [{ embedding: [0.1] }] }));
    try {
      const client = new OpenAiCompatibleEmbeddingClient();
      await client.embed({ texts: ["x"], model: "m", provider: provider({ api_endpoint: "${TEST_EMBED_HOST}" }) });
      expect(String(fetchMock.mock.calls[0]![0])).toBe("https://embed.example.com/v1/embeddings");
    } finally {
      delete process.env.TEST_EMBED_HOST;
    }
  });

  it("HTTP 非2xx 抛错携带响应 message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: { message: "rate limited" } }, 429),
    );
    const client = new OpenAiCompatibleEmbeddingClient();
    await expect(client.embed({ texts: ["x"], model: "m", provider: provider() })).rejects.toThrow("rate limited");
  });

  it("响应向量数量不匹配抛错", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ data: [{ embedding: [0.1] }] }));
    const client = new OpenAiCompatibleEmbeddingClient();
    await expect(client.embed({ texts: ["a", "b"], model: "m", provider: provider() })).rejects.toThrow(/mismatch/);
  });

  it("空输入不请求,返回空数组", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new OpenAiCompatibleEmbeddingClient();
    const vectors = await client.embed({ texts: [], model: "m", provider: provider() });
    expect(vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("endpoint 缺失抛错", async () => {
    const client = new OpenAiCompatibleEmbeddingClient();
    await expect(
      client.embed({
        texts: ["x"],
        model: "m",
        provider: provider({ api_endpoint: "", provider_type: "unknown_type" }),
      }),
    ).rejects.toThrow(/api_endpoint/);
  });
});
