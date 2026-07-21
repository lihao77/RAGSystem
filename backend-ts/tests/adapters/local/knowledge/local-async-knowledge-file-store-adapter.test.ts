import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalAsyncKnowledgeFileStoreAdapter } from "../../../../src/adapters/local/knowledge/local-async-knowledge-file-store-adapter.js";
import type {
  IKnowledgeFileStore,
  KnowledgeFile,
} from "../../../../src/contracts/vector-store/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-knowledge-files-"));
  temporaryRoots.push(root);
  return root;
}

function fileAt(storedPath: string): KnowledgeFile {
  return {
    id: "file-1",
    original_name: "source.txt",
    stored_name: "stored.txt",
    stored_path: storedPath,
    size: 5,
    mime: "text/plain",
    uploaded_at: "2026-01-01T00:00:00.000Z",
    md_blob_hash: null,
  };
}

function makeStore(root: string, file: KnowledgeFile | null): IKnowledgeFileStore {
  return {
    listKnowledgeFiles: vi.fn(() => file ? [file] : []),
    getKnowledgeFile: vi.fn((fileId) => fileId === file?.id ? file : null),
    addKnowledgeFile: vi.fn(() => file!),
    deleteKnowledgeFile: vi.fn(() => file),
    getKnowledgeUploadsRoot: vi.fn(() => root),
    putKnowledgeMarkdown: vi.fn(() => ({ md_blob_hash: "hash" })),
    readKnowledgeMarkdown: vi.fn(() => "markdown"),
  };
}

describe("Local async knowledge file store adapter", () => {
  it("delegates metadata and Markdown operations through the asynchronous port", async () => {
    const root = await temporaryRoot();
    const file = fileAt(path.join(root, "stored.txt"));
    const store = makeStore(root, file);
    const adapter = new LocalAsyncKnowledgeFileStoreAdapter(store);

    await expect(adapter.listKnowledgeFiles()).resolves.toEqual([file]);
    await expect(adapter.getKnowledgeFile("file-1")).resolves.toBe(file);
    await expect(adapter.putKnowledgeMarkdown("file-1", "updated")).resolves.toEqual({ md_blob_hash: "hash" });
    await expect(adapter.readKnowledgeMarkdown("hash")).resolves.toBe("markdown");
    await expect(adapter.deleteKnowledgeFile("file-1")).resolves.toBe(file);
  });

  it("reads source bytes only from a regular file inside the uploads root", async () => {
    const root = await temporaryRoot();
    const storedPath = path.join(root, "stored.txt");
    await fs.writeFile(storedPath, "hello");
    const adapter = new LocalAsyncKnowledgeFileStoreAdapter(makeStore(root, fileAt(storedPath)));

    await expect(adapter.getSource("file-1")).resolves.toEqual({
      body: Buffer.from("hello"),
      contentType: "text/plain",
    });
  });

  it("rejects metadata paths and symlinks that escape the uploads root", async () => {
    const sandbox = await temporaryRoot();
    const root = path.join(sandbox, "uploads");
    const outside = path.join(sandbox, "outside.txt");
    await fs.mkdir(root);
    await fs.writeFile(outside, "secret");

    const escaped = new LocalAsyncKnowledgeFileStoreAdapter(makeStore(root, fileAt(outside)));
    await expect(escaped.getSource("file-1")).resolves.toBeNull();

    const link = path.join(root, "linked.txt");
    try {
      await fs.symlink(outside, link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const linked = new LocalAsyncKnowledgeFileStoreAdapter(makeStore(root, fileAt(link)));
    await expect(linked.getSource("file-1")).resolves.toBeNull();
  });

  it("returns null when metadata or source bytes do not exist", async () => {
    const root = await temporaryRoot();
    const missingPath = path.join(root, "missing.txt");
    await expect(new LocalAsyncKnowledgeFileStoreAdapter(makeStore(root, null)).getSource("missing"))
      .resolves.toBeNull();
    await expect(new LocalAsyncKnowledgeFileStoreAdapter(makeStore(root, fileAt(missingPath))).getSource("file-1"))
      .resolves.toBeNull();
  });
});
