import { describe, expect, it } from "vitest";

import { AgentConfigSchema } from "../../src/contracts/agent/agent-config.js";
import type { VectorSearchResult } from "../../src/contracts/knowledge/knowledge-base.js";
import type { KnowledgeQueryPort } from "../../src/contracts/knowledge/query-port.js";
import { createKnowledgeTools } from "../../src/tools/KnowledgeTools/KnowledgeTools.js";
import { toolContext } from "../helpers/tool-context.js";

describe("KnowledgeTools search result formatting", () => {
  it("reports final rerank score instead of the earlier vector score", async () => {
    const result: VectorSearchResult = {
      id: "chunk-1",
      doc_id: "doc-1",
      document_id: "doc-1",
      collection: "documents",
      text: "relevant content",
      content: "relevant content",
      metadata: { source_file: "guide.md" },
      score: 0.95,
      similarity: 0.2,
      keyword_score: 0.8,
      vector_score: 0.2,
      hybrid_score: 0.9,
      final_score: 0.95,
      score_type: "rerank",
      final_rank: 1,
      vector_rank: 2,
      keyword_rank: 1,
      hybrid_rank: 1,
      retrieval_sources: ["vector", "keyword"],
      rerank_score: 0.95,
      rerank_rank: 1,
    };
    const knowledge: KnowledgeQueryPort = {
      search: async () => ({
        results: [result],
        count: 1,
        collection_name: "documents",
        collection_scope: "single",
        query: "relevant",
        search_mode: "hybrid",
        rerank_requested: true,
        rerank: true,
        rerank_mode: "model",
        rerank_error: null,
        diagnostics: {
          candidate_count: 1,
          vector_candidate_count: 1,
          keyword_candidate_count: 1,
          fused_candidate_count: 1,
          filters_applied: [],
          fusion: { method: "rrf", rrf_k: 60 },
          vectorizer: { vectorizer_key: "embed", provider_key: "provider", model_name: "model", model_id: 1 },
          reranker: { reranker_key: "rerank", provider_key: "provider", model_name: "rerank-model", mode: "model" },
          timings_ms: { embedding: 1, retrieval: 1, vector_retrieval: 1, keyword_retrieval: 1, scoring: 1, rerank: 1, total: 6 },
        },
      }),
      listCollections: async () => [],
    };
    const agent = AgentConfigSchema.parse({
      agent_name: "reviewer",
      knowledge_base: { enabled: true, default_collection: "documents", default_rerank: true },
    });
    const tool = createKnowledgeTools({ knowledge, agent }).find((item) => item.name === "search_knowledge_base");
    expect(tool).toBeTruthy();

    const output = await tool!.call({ query: "relevant" }, toolContext());
    expect(String(output.content)).toContain("score: 0.9500");
    expect(String(output.content)).not.toContain("score: 0.2000");
  });
});
