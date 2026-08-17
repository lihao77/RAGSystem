import { afterEach, describe, expect, it } from "vitest";

import { OpenAiCompatibleRerankClient } from "../src/services/integrations/reranker-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAiCompatibleRerankClient", () => {
  it("preserves a DashScope-compatible /reranks endpoint and reads nested output", async () => {
    let capturedUrl = "";
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({
        output: {
          results: [
            { index: 1, relevance_score: 0.2 },
            { index: 0, relevance_score: 0.9 },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const scores = await new OpenAiCompatibleRerankClient().rerank({
      query: "query",
      documents: ["first", "second"],
      reranker: {
        reranker_key: "qwen-reranker",
        model_name: "qwen3-rerank",
        api_endpoint: "https://example.com/compatible-api/v1/reranks",
        api_key: "secret",
      },
      topN: 2,
    });

    expect(capturedUrl).toBe("https://example.com/compatible-api/v1/reranks");
    expect(scores).toEqual([0.9, 0.2]);
  });
});
