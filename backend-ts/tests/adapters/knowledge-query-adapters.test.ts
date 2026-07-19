import { describe, expect, it, vi } from "vitest";

import { LocalKnowledgeQueryAdapter } from "../../src/adapters/local/local-knowledge-query-adapter.js";
import { PostgresKnowledgeQueryAdapter } from "../../src/adapters/saas/postgres/knowledge-query-adapter.js";
import type { KnowledgeBaseService } from "../../src/services/knowledge/knowledge-base-service.js";

describe("knowledge query adapters", () => {
  it("keeps Local Agent queries behind the shared port", async () => {
    const search = vi.fn().mockResolvedValue({ results: [], count: 0 });
    const listCollections = vi.fn().mockResolvedValue([]);
    const adapter = new LocalKnowledgeQueryAdapter({ search, listCollections } as never);

    await adapter.search({ query: "hello", collection: "docs" });
    await adapter.listCollections();

    expect(search).toHaveBeenCalledWith({ query: "hello", collection: "docs" });
    expect(listCollections).toHaveBeenCalledOnce();
  });

  it("binds SaaS Agent queries to the tenant pgvector view", async () => {
    const search = vi.fn().mockResolvedValue({ results: [], count: 0 });
    const listCollections = vi.fn().mockResolvedValue([]);
    const withAsyncVectorStore = vi.fn().mockReturnValue({ search, listCollections });
    const base = { withAsyncVectorStore } as unknown as KnowledgeBaseService;
    const vectors = { upsertChunks: vi.fn(), search: vi.fn(), listCollections: vi.fn(), deleteChunks: vi.fn() };
    const adapter = new PostgresKnowledgeQueryAdapter("tenant-1", base, vectors);

    await adapter.search({ query: "hello", collection: "docs" });
    await adapter.listCollections();

    expect(withAsyncVectorStore).toHaveBeenCalledWith(vectors, "tenant-1");
    expect(search).toHaveBeenCalledWith({ query: "hello", collection: "docs" });
    expect(listCollections).toHaveBeenCalledOnce();
  });
});
