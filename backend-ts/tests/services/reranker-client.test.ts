import { afterEach, describe, expect, it, vi } from "vitest";
import { externalCallPolicy } from "@ragsystem/agent-llm";
import type { StoredReranker } from "../../src/contracts/vector-store/index.js";
import { OpenAiCompatibleRerankClient } from "../../src/services/integrations/reranker-client.js";

const stored = (overrides: Partial<StoredReranker> = {}): StoredReranker => ({ reranker_key: "rr", mode: "model", provider_key: "p", provider_type: "openai", model_name: "m", api_endpoint: "https://example.test/v1", api_key: "k", created_at: "now", is_active: true, ...overrides });
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }) as Response;

afterEach(() => { externalCallPolicy.reset(); vi.restoreAllMocks(); });

describe("OpenAiCompatibleRerankClient", () => {
  it("补 /rerank 并兼容 relevance_score 与 score", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ results: [{ index: 0, relevance_score: 0.8 }, { index: 1, score: 0.2 }] }));
    const scores = await new OpenAiCompatibleRerankClient().rerank({ query: "q", documents: ["a", "b"], reranker: stored() });
    expect(scores).toEqual([0.8, 0.2]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://example.test/v1/rerank");
  });

  it("已有 /rerank 不重复追加", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ results: [{ index: 0, score: 1 }] }));
    await new OpenAiCompatibleRerankClient().rerank({ query: "q", documents: ["a"], reranker: stored({ api_endpoint: "https://example.test/rerank/" }) });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://example.test/rerank");
  });

  it("响应数量不匹配抛错", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ results: [{ index: 0, score: 1 }] }));
    await expect(new OpenAiCompatibleRerankClient().rerank({ query: "q", documents: ["a", "b"], reranker: stored() })).rejects.toThrow("count mismatch");
  });

  it("空 documents 不请求", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(new OpenAiCompatibleRerankClient().rerank({ query: "q", documents: [], reranker: stored() })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
