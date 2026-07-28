import fs from "node:fs";

import type { FileChangeHistoryPort } from "@ragsystem/backend-core/contracts/file-history-store/index.js";
import type { FileHistoryService } from "./file-history-service.js";

/** Projects synchronous filesystem history into File Change's Promise-based read port. */
export class LocalFileChangeHistoryAdapter implements FileChangeHistoryPort {
  constructor(private readonly history: FileHistoryService) {}

  async listSnapshots(sessionId: string) {
    return this.history.listSnapshots(sessionId);
  }

  async getPendingTracked(sessionId: string) {
    return this.history.getPendingTracked(sessionId);
  }

  async readBackup(sessionId: string, backupHash: string): Promise<Uint8Array | null> {
    const content = this.history.readBackup(sessionId, backupHash);
    return content === null ? null : Buffer.from(content, "utf8");
  }

  async readCurrent(filePath: string): Promise<Uint8Array | null> {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile() ? fs.promises.readFile(filePath) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
