import { describe, expect, it, vi } from "vitest";

import { LocalAsyncKnowledgeMarkdownPipeline } from "../../../../src/adapters/local/knowledge/local-async-knowledge-markdown-pipeline.js";
import type {
  IKnowledgeFileStore,
  KnowledgeFile,
} from "../../../../src/contracts/vector-store/index.js";

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
    listKnowledgeFiles: vi.fn(() => [file]),
    getKnowledgeFile: vi.fn((fileId: string) => fileId === file.id ? file : null),
    addKnowledgeFile: vi.fn(),
    deleteKnowledgeFile: vi.fn(),
    getKnowledgeUploadsRoot: vi.fn(() => "C:/uploads"),
    putKnowledgeMarkdown: vi.fn((fileId: string, content: string) => {
      if (fileId !== file.id) throw new Error("missing");
      const hash = `hash-${content}`;
      markdown.set(hash, content);
      file = { ...file, md_blob_hash: hash };
      return { md_blob_hash: hash };
    }),
    readKnowledgeMarkdown: vi.fn((hash: string) => {
      const content = markdown.get(hash);
      if (content === undefined) throw new Error("missing blob");
      return content;
    }),
  } as unknown as IKnowledgeFileStore;
  const knowledge = {
    generateMarkdownForFile: vi.fn(async (fileId: string) => {
      store.putKnowledgeMarkdown(fileId, "generated");
    }),
  };
  return { store, knowledge };
}

describe("Local async knowledge Markdown pipeline", () => {
  it("uses KnowledgeBaseService extraction and returns its persisted hash", async () => {
    const { store, knowledge } = makeFixture();
    const pipeline = new LocalAsyncKnowledgeMarkdownPipeline(store, knowledge);

    await expect(pipeline.generateMarkdownForFile("file-1"))
      .resolves.toEqual({ md_blob_hash: "hash-generated" });
    expect(knowledge.generateMarkdownForFile).toHaveBeenCalledWith("file-1");
  });

  it("reads and updates canonical Markdown through the Local store", async () => {
    const { store, knowledge } = makeFixture("hash-existing");
    const pipeline = new LocalAsyncKnowledgeMarkdownPipeline(store, knowledge);

    await expect(pipeline.readMarkdownForFile("file-1")).resolves.toEqual({
      markdown: "existing",
      md_blob_hash: "hash-existing",
    });
    await expect(pipeline.updateMarkdown("file-1", "updated"))
      .resolves.toEqual({ md_blob_hash: "hash-updated" });
  });

  it("rejects missing files and Markdown that has not been generated", async () => {
    const { store, knowledge } = makeFixture();
    const pipeline = new LocalAsyncKnowledgeMarkdownPipeline(store, knowledge);

    await expect(pipeline.readMarkdownForFile("file-1")).rejects.toThrow("Markdown 尚未生成");
    await expect(pipeline.readMarkdownForFile("missing")).rejects.toThrow("知识库文件不存在");
    await expect(pipeline.updateMarkdown("missing", "content")).rejects.toThrow("知识库文件不存在");
  });
});
