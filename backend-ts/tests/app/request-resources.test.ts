import { describe, expect, it, vi } from "vitest";

import { createRequestResources, ensureRequestResources } from "../../src/app/request-resources.js";

describe("request resources", () => {
  it("resolves tenant resources once and reuses the request cache", async () => {
    const knowledgeFileStore = {};
    const knowledgeMarkdownPipeline = {};
    const sessionFileStorage = {};
    const fileHistoryStorage = {};
    const options = {
      resolveKnowledgeFileStore: vi.fn().mockResolvedValue(knowledgeFileStore),
      resolveKnowledgeMarkdownPipeline: vi.fn().mockResolvedValue(knowledgeMarkdownPipeline),
      resolveSessionFileStorage: vi.fn().mockResolvedValue(sessionFileStorage),
      resolveFileHistoryStorage: vi.fn().mockResolvedValue(fileHistoryStorage),
    };
    const request = {} as never;
    const first = await ensureRequestResources(request, options as never);
    const second = await ensureRequestResources(request, options as never);
    expect(first).toBe(second);
    expect(first).toEqual({ knowledgeFileStore, knowledgeMarkdownPipeline, sessionFileStorage, fileHistoryStorage });
    expect(options.resolveKnowledgeFileStore).toHaveBeenCalledOnce();
    expect(options.resolveKnowledgeMarkdownPipeline).toHaveBeenCalledOnce();
    expect(options.resolveSessionFileStorage).toHaveBeenCalledOnce();
    expect(options.resolveFileHistoryStorage).toHaveBeenCalledOnce();
    await expect(createRequestResources({} as never, options as never)).resolves.toEqual(first);
  });

  it("rejects missing SaaS resources instead of exposing Local stores", async () => {
    await expect(createRequestResources({
      container: { deploymentKind: "saas" },
    } as never, {} as never)).rejects.toThrow("SaaS knowledge file store resolver returned no implementation");
  });
});
