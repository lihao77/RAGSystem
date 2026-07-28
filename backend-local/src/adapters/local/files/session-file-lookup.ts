import fs from "node:fs";
import path from "node:path";

import type { SessionFileLookupPort } from "@ragsystem/backend-core/contracts/session/session-file-storage.js";
import type { UploadedFileRecord } from "@ragsystem/backend-core/contracts/storage/files.js";
import type { FileIndexService } from "./file-index-service.js";

/** Promise-semantic session-file lookup over the local synchronous index. */
export class LocalSessionFileLookup implements SessionFileLookupPort {
  constructor(private readonly files: FileIndexService) {}

  async get(sessionId: string, fileId: string): Promise<UploadedFileRecord | null> {
    return this.files.get(fileId, "session", sessionId);
  }

  async read(sessionId: string, fileId: string): Promise<{ body: Uint8Array; contentType: string | null } | null> {
    const record = this.files.get(fileId, "session", sessionId);
    if (!record) return null;
    const storedPath = path.resolve(record.stored_path);
    const uploadsRoot = path.resolve(this.files.getSessionUploadsRoot(sessionId));
    const relative = path.relative(uploadsRoot, storedPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    try {
      return { body: await fs.promises.readFile(storedPath), contentType: record.mime || null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
