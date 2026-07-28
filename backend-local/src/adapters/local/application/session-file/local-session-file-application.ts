import fs from "node:fs";
import path from "node:path";

import type { SessionFileApplication, SessionFileReadResult } from "@ragsystem/backend-core/contracts/application/session-file-application.js";
import type { FileIndexService } from "../../files/file-index-service.js";

export class LocalSessionFileApplication implements SessionFileApplication {
  constructor(private readonly files: FileIndexService) {}

  async list(sessionId: string) {
    return this.files.list({ scopeType: "session", scopeId: sessionId });
  }

  async validate(sessionId: string, fileIds: readonly string[]) {
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const fileId of fileIds) {
      (await this.get(sessionId, fileId) ? valid : invalid).push(fileId);
    }
    return { valid, invalid };
  }

  async add(sessionId: string, input: { originalName: string; buffer: Uint8Array; mime: string }) {
    return this.files.add({
      originalName: input.originalName,
      buffer: input.buffer,
      mime: input.mime,
      scopeType: "session",
      scopeId: sessionId,
    });
  }

  async get(sessionId: string, fileId: string) {
    return this.files.get(fileId, "session", sessionId);
  }

  async delete(sessionId: string, fileId: string) {
    const record = this.files.delete(fileId, "session", sessionId);
    if (!record) return null;
    await removeFile(record.stored_path, this.files.getSessionUploadsRoot(sessionId));
    return record;
  }

  async read(sessionId: string, fileId: string): Promise<SessionFileReadResult> {
    const record = await this.get(sessionId, fileId);
    if (!record) return { status: "not_found" };
    const storedPath = path.resolve(record.stored_path);
    if (!isPathUnder(storedPath, this.files.getSessionUploadsRoot(sessionId))) {
      return { status: "content_missing" };
    }
    try {
      const stats = await fs.promises.stat(storedPath);
      if (!stats.isFile()) return { status: "content_missing" };
      return {
        status: "found",
        record,
        body: await fs.promises.readFile(storedPath),
        contentType: record.mime,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "content_missing" };
      throw error;
    }
  }
}

async function removeFile(storedPath: string, expectedRoot: string): Promise<void> {
  const resolved = path.resolve(storedPath);
  if (!isPathUnder(resolved, expectedRoot)) return;
  try {
    const stats = await fs.promises.stat(resolved);
    if (stats.isFile()) await fs.promises.unlink(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
