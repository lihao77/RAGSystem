import type { SessionFileApplication, SessionFileReadResult } from "@ragsystem/backend-core/contracts/application/session-file-application.js";
import type { AsyncSessionFileStorage } from "@ragsystem/backend-core/contracts/session/session-file-storage.js";

export class SaaSSessionFileApplication implements SessionFileApplication {
  constructor(private readonly files: AsyncSessionFileStorage) {}

  list(sessionId: string) { return this.files.list(sessionId); }

  async validate(sessionId: string, fileIds: readonly string[]) {
    const records = await Promise.all(fileIds.map((fileId) => this.files.get(sessionId, fileId)));
    return {
      valid: fileIds.filter((_fileId, index) => records[index] !== null),
      invalid: fileIds.filter((_fileId, index) => records[index] === null),
    };
  }

  add(sessionId: string, input: { originalName: string; buffer: Uint8Array; mime: string }) {
    return this.files.add(sessionId, input);
  }

  get(sessionId: string, fileId: string) { return this.files.get(sessionId, fileId); }
  delete(sessionId: string, fileId: string) { return this.files.delete(sessionId, fileId); }

  async read(sessionId: string, fileId: string): Promise<SessionFileReadResult> {
    const record = await this.files.get(sessionId, fileId);
    if (!record) return { status: "not_found" };
    const source = await this.files.read(sessionId, fileId);
    if (!source) return { status: "not_found" };
    return {
      status: "found",
      record,
      body: source.body,
      contentType: source.contentType,
    };
  }
}
