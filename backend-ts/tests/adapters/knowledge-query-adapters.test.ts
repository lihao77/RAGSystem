import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { LocalKnowledgeQueryAdapter } from "../../src/adapters/local/local-knowledge-query-adapter.js";

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

  it("does not keep an empty SaaS passthrough knowledge query adapter", () => {
    expect(fs.existsSync(path.resolve("src/adapters/saas/postgres/knowledge-query-adapter.ts"))).toBe(false);
  });
});
