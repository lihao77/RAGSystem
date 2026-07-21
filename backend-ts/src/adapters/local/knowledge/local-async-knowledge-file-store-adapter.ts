import fs from "node:fs/promises";
import path from "node:path";

import type { AsyncKnowledgeFileStore } from "../../../contracts/knowledge/async-knowledge-file-store.js";
import type {
  AddKnowledgeFileInput,
  IKnowledgeFileStore,
  KnowledgeFile,
} from "../../../contracts/vector-store/index.js";

/** Promise-based view over a tenant-bound Local knowledge file store. */
export class LocalAsyncKnowledgeFileStoreAdapter implements AsyncKnowledgeFileStore {
  constructor(private readonly store: IKnowledgeFileStore) {}

  async listKnowledgeFiles(): Promise<KnowledgeFile[]> {
    return this.store.listKnowledgeFiles();
  }

  async getKnowledgeFile(fileId: string): Promise<KnowledgeFile | null> {
    return this.store.getKnowledgeFile(fileId);
  }

  async addKnowledgeFile(input: AddKnowledgeFileInput): Promise<KnowledgeFile> {
    return this.store.addKnowledgeFile(input);
  }

  async deleteKnowledgeFile(fileId: string): Promise<KnowledgeFile | null> {
    return this.store.deleteKnowledgeFile(fileId);
  }

  async putKnowledgeMarkdown(fileId: string, markdown: string): Promise<{ md_blob_hash: string }> {
    return this.store.putKnowledgeMarkdown(fileId, markdown);
  }

  async readKnowledgeMarkdown(mdBlobHash: string): Promise<string> {
    return this.store.readKnowledgeMarkdown(mdBlobHash);
  }

  async getSource(fileId: string): Promise<{ body: Uint8Array; contentType: string | null } | null> {
    const file = this.store.getKnowledgeFile(fileId);
    if (!file) return null;

    const uploadsRoot = path.resolve(this.store.getKnowledgeUploadsRoot());
    const storedPath = path.resolve(file.stored_path);
    if (!isPathWithin(storedPath, uploadsRoot)) return null;

    try {
      const [realRoot, realStoredPath] = await Promise.all([
        fs.realpath(uploadsRoot),
        fs.realpath(storedPath),
      ]);
      if (!isPathWithin(realStoredPath, realRoot)) return null;
      const handle = await fs.open(realStoredPath, "r");
      try {
        if (!(await handle.stat()).isFile()) return null;
        return {
          body: await handle.readFile(),
          contentType: file.mime || null,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isMissingOrInvalidPath(error)) return null;
      throw error;
    }
  }
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingOrInvalidPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}
