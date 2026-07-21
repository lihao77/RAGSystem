import { describe, expect, it, vi } from "vitest";

import { LocalAsyncKnowledgeMarkdownPipeline } from "../../../../src/adapters/local/knowledge/local-async-knowledge-markdown-pipeline.js";
import type { AsyncKnowledgeFileStore } from "../../../../src/contracts/knowledge/async-knowledge-file-store.js";
import type { DocumentExtractor } from "../../../../src/contracts/knowledge/document-extractor.js";
import type { KnowledgeFile } from "../../../../src/contracts/vector-store/index.js";

function makeFixture(initialHash: string | null = null) {
  let file: KnowledgeFile = {
    id: "file-1",
    original_name: "source.txt",
    stored_name: "stored.txt",
    stored_path: "C:/uploads/stored.txt",
    size: 5,
    mime: "text/plain",
    uploaded_at: "2026-01-01T00:00:00.000Z",
    md_blob_hash: initialHash,
  };
  const markdown = new Map<string, string>();
  if (initialHash) markdown.set(initialHash, "existing");
  const store = {
    listKnowledgeFiles: vi.fn(async () => [file]),
    getKnowledgeFile: vi.fn(async (fileId: string) => fileId === file.id ? file : null),
    addKnowledgeFile: vi.fn(),
    deleteKnowledgeFile: vi.fn(),
    putKnowledgeMarkdown: vi.fn(async (fileId: string, content: string) => {
      if (fileId !== file.id) throw new Error("missing");
      const hash = `hash-${content}`;
      markdown.set(hash, content);
      file = { ...file, md_blob_hash: hash };
      return { md_blob_hash: hash };
    }),
    readKnowledgeMarkdown: vi.fn(async (hash: string) => {
      const content = markdown.get(hash);
      if (content === undefined) throw new Error("missing blob");
      return content;
    }),
    getSource: vi.fn(async () => null),
  } as unknown as AsyncKnowledgeFileStore;
  const extractor: DocumentExtractor = {
    extract: vi.fn(async () => ({ text: "generated", markdown: "generated", kind: "text" })),
  };
  return { store, extractor };
}

describe("Local async knowledge Markdown pipeline", () => {
  it("extracts via DocumentExtractor and returns the persisted hash", async () => {
    const { store, extractor } = makeFixture();
    const pipeline = new LocalAsyncKnowledgeMarkdownPipeline(store, extractor);

    await expect(pipeline.generateMarkdownForFile("file-1"))
      .resolves.toEqual({ md_blob_hash: "hash-generated" });
    expect(extractor.extract).toHaveBeenCalledWith({
      file_path: "C:/uploads/stored.txt",
      file_name: "source.txt",
      mime: "text/plain",
    });
    expect(store.putKnowledgeMarkdown).toHaveBeenCalledWith("file-1", "generated");
  });

  it("reads and updates canonical Markdown through the Local store", async () => {
    const { store, extractor } = makeFixture("hash-existing");
    const pipeline = new LocalAsyncKnowledgeMarkdownPipeline(store, extractor);

    await expect(pipeline.readMarkdownForFile("file-1")).resolves.toEqual({
      markdown: "existing",
      md_blob_hash: "hash-existing",
    });
    await expect(pipeline.updateMarkdown("file-1", "updated"))
      .resolves.toEqual({ md_blob_hash: "hash-updated" });
  });

  it("rejects missing files and Markdown that has not been generated", async () => {
    const { store, extractor } = makeFixture();
    const pipeline = new LocalAsyncKnowledgeMarkdownPipeline(store, extractor);

    await expect(pipeline.readMarkdownForFile("file-1")).rejects.toThrow("Markdown 尚未生成");
    await expect(pipeline.readMarkdownForFile("missing")).rejects.toThrow("知识库文件不存在");
    await expect(pipeline.updateMarkdown("missing", "content")).rejects.toThrow("知识库文件不存在");
  });
});
