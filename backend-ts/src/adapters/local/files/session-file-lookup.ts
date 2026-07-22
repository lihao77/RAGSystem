import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";
import type { UploadedFileRecord } from "../../../contracts/storage/files.js";
import type { IFileIndexStore } from "../../../contracts/file-index-store/index.js";

/** Promise-semantic session-file lookup over the local synchronous index. */
export class LocalSessionFileLookup implements SessionFileLookupPort {
  constructor(private readonly files: IFileIndexStore) {}

  async get(sessionId: string, fileId: string): Promise<UploadedFileRecord | null> {
    return this.files.get(fileId, "session", sessionId);
  }
}
