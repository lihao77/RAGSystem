import { describe, expect, it, vi } from "vitest";

import { KnowledgeHttpApplication } from "../../src/services/knowledge/knowledge-http-application.js";

describe("KnowledgeHttpApplication", () => {
  it("owns the file, markdown, and vector workflow behind one shared port", async () => {
    const file = {
      id: "file-1", original_name: "a.md", stored_name: "a", stored_path: "object://a",
      size: 3, mime: "text/markdown", uploaded_at: "2026-01-01T00:00:00Z", md_blob_hash: null,
    };
    const indexed = { ...file, md_blob_hash: "hash-1" };
    const files = {
      addKnowledgeFile: vi.fn().mockResolvedValue(file),
      getKnowledgeFile: vi.fn().mockResolvedValue(indexed),
      listKnowledgeFiles: vi.fn().mockResolvedValue([indexed]),
      getSource: vi.fn().mockResolvedValue({ body: Buffer.from("# A"), contentType: "text/markdown" }),
      deleteKnowledgeFile: vi.fn().mockResolvedValue(indexed),
    };
    const markdown = {
      generateMarkdownForFile: vi.fn().mockResolvedValue({ md_blob_hash: "hash-1" }),
      readMarkdownForFile: vi.fn().mockResolvedValue({ markdown: "# A", md_blob_hash: "hash-1" }),
      updateMarkdown: vi.fn().mockResolvedValue({ md_blob_hash: "hash-2" }),
    };
    const vector = {
      deleteKnowledgeVectors: vi.fn().mockResolvedValue(2),
      indexExternalFile: vi.fn().mockResolvedValue({ indexed_chunks: 1 }),
      fileStatus: vi.fn().mockResolvedValue({ files: [], vectorizers: [] }),
    };
    const application = new KnowledgeHttpApplication(vector as never, files as never, markdown as never);

    await expect(application.upload([{ filename: "a.md", buffer: Buffer.from("# A"), mime: "text/markdown" }])).resolves.toEqual([indexed]);
    expect(markdown.generateMarkdownForFile).toHaveBeenCalledWith("file-1");
    await expect(application.download("file-1")).resolves.toMatchObject({ filename: "a.md", mime: "text/markdown" });
    await expect(application.indexFile({ collection: "docs", file_id: "file-1", vectorizer_key: "embed" })).resolves.toEqual({ indexed_chunks: 1 });
    await expect(application.fileStatus()).resolves.toEqual({ files: [], vectorizers: [] });
    await expect(application.deleteFile("file-1")).resolves.toEqual({ deleted_chunks: 2 });
  });

  it("delegates tenant reranker and chunk management", async () => {
    const knowledge = {
      listFileChunks: vi.fn().mockResolvedValue([]),
      updateChunk: vi.fn().mockResolvedValue({ id: "chunk-1" }),
      listRerankers: vi.fn().mockResolvedValue([]),
      addReranker: vi.fn().mockResolvedValue({ reranker_key: "bm25_local" }),
      getReranker: vi.fn().mockResolvedValue(null),
      activateReranker: vi.fn().mockResolvedValue({ active_reranker_key: "bm25_local" }),
      deleteReranker: vi.fn().mockResolvedValue({ deleted_reranker_key: "bm25_local" }),
    };
    const files = { getKnowledgeFile: vi.fn().mockResolvedValue({ id: "file-1" }) };
    const application = new KnowledgeHttpApplication(knowledge as never, files as never, {} as never);
    await expect(application.listChunks("file-1")).resolves.toEqual([]);
    await expect(application.updateChunk("file-1", "chunk-1", "updated")).resolves.toEqual({ id: "chunk-1" });
    await expect(application.listRerankers()).resolves.toEqual([]);
    await expect(application.addReranker({ mode: "lexical" })).resolves.toEqual({ reranker_key: "bm25_local" });
    await expect(application.getReranker("bm25_local")).resolves.toBeNull();
    await expect(application.activateReranker("bm25_local")).resolves.toEqual({ active_reranker_key: "bm25_local" });
    await expect(application.deleteReranker("bm25_local")).resolves.toEqual({ deleted_reranker_key: "bm25_local" });
  });
});
