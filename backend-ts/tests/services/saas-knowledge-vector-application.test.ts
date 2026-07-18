import { describe, expect, it, vi } from "vitest";
import type { KnowledgeBaseService } from "../../src/services/knowledge/knowledge-base-service.js";
import { SaaSKnowledgeVectorApplication } from "../../src/services/runtime/saas-knowledge-vector-application.js";

describe("SaaSKnowledgeVectorApplication", () => {
  it("reads tenant file markdown before indexing through the async vector view", async () => {
    const indexExternalFile = vi.fn().mockResolvedValue({ indexed_chunks: 2 });
    const base = { withAsyncVectorStore: vi.fn().mockReturnValue({ indexExternalFile }) } as unknown as KnowledgeBaseService;
    const files = { getKnowledgeFile: vi.fn().mockResolvedValue({ id: "file-1", original_name: "a.md" }) };
    const markdown = { readMarkdownForFile: vi.fn().mockResolvedValue({ markdown: "# A", md_blob_hash: "hash" }) };
    const vectors = { deleteChunks: vi.fn(), upsertChunks: vi.fn(), search: vi.fn() };
    const application = new SaaSKnowledgeVectorApplication("tenant-1", base, files as never, markdown as never, vectors);

    await expect(application.indexFile({ file_id: "file-1", collection: "docs", vectorizer_key: "embed" })).resolves.toEqual({ indexed_chunks: 2 });
    expect(base.withAsyncVectorStore).toHaveBeenCalledWith(vectors, "tenant-1");
    expect(indexExternalFile).toHaveBeenCalledWith(expect.objectContaining({ file_id: "file-1" }), expect.objectContaining({ id: "file-1" }), "# A");
  });

  it("deletes tenant vectors before deleting the file", async () => {
    const base = { withAsyncVectorStore: vi.fn().mockReturnValue({}) } as unknown as KnowledgeBaseService;
    const files = { getKnowledgeFile: vi.fn().mockResolvedValue({ id: "file-1" }), deleteKnowledgeFile: vi.fn().mockResolvedValue({ id: "file-1" }) };
    const vectors = { deleteChunks: vi.fn().mockResolvedValue(3), upsertChunks: vi.fn(), search: vi.fn() };
    const application = new SaaSKnowledgeVectorApplication("tenant-1", base, files as never, {} as never, vectors);

    await expect(application.deleteKnowledgeFile("file-1")).resolves.toEqual({ deleted_chunks: 3 });
    expect(vectors.deleteChunks).toHaveBeenCalledWith({ tenant_id: "tenant-1", document_id: "file-1" });
    expect(files.deleteKnowledgeFile).toHaveBeenCalledWith("file-1");
  });
});
