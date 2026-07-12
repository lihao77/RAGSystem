import { describe, expect, it } from "vitest";
import type { StoredReranker } from "../../src/contracts/vector-store/index.js";
import type { VectorSearchResult } from "../../src/contracts/knowledge-base.js";
import type { RerankClient } from "../../src/services/integrations/reranker-client.js";
import { createReranker, LexicalReranker, NoopReranker, RemoteReranker } from "../../src/services/integrations/reranker-registry.js";

const stored = (mode: StoredReranker["mode"]): StoredReranker => ({ reranker_key: "rr", mode, provider_key: "p", provider_type: null, model_name: "m", api_endpoint: "http://x", api_key: "k", created_at: "now", is_active: true });
const result = (id: string, content: string): VectorSearchResult => ({ id, doc_id: id, document_id: id, collection: "c", text: content, content, metadata: {}, score: 0, similarity: 0, keyword_score: 0, vector_score: 0, hybrid_score: 0 });

describe("reranker-registry", () => {
  it("按 mode 分派实现", () => {
    expect(createReranker(stored("model"))).toBeInstanceOf(RemoteReranker);
    expect(createReranker(stored("lexical"))).toBeInstanceOf(LexicalReranker);
    expect(createReranker(stored("none"))).toBeInstanceOf(NoopReranker);
  });

  it("RemoteReranker 注入 client 并按分数排序", async () => {
    const client: RerankClient = { rerank: async () => [0.1, 0.9] };
    const reranked = await createReranker(stored("model"), client).rerank("q", [result("1", "a"), result("2", "b")]);
    expect(reranked.mode).toBe("model");
    expect(reranked.results.map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("lexical 与 none 返回对应 mode", async () => {
    await expect(createReranker(stored("lexical")).rerank("match", [result("1", "match"), result("2", "other")])).resolves.toMatchObject({ mode: "lexical" });
    await expect(createReranker(stored("none")).rerank("q", [result("1", "a")])).resolves.toMatchObject({ mode: "none" });
  });
});
