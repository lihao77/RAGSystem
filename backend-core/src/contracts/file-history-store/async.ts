import type { FileHistoryRewindResult, FileHistorySnapshot, FileHistoryTrackedFile } from "./types.js";

/** Promise-based read model used by the File Change projection. */
export interface FileChangeHistoryPort {
  listSnapshots(sessionId: string): Promise<FileHistorySnapshot[]>;
  getPendingTracked(sessionId: string): Promise<Record<string, FileHistoryTrackedFile> | null>;
  readBackup(sessionId: string, backupHash: string): Promise<Uint8Array | null>;
  /** Reads the current tracked file/object by its deployment-scoped key. */
  readCurrent(fileKey: string): Promise<Uint8Array | null>;
}

export interface AsyncFileHistoryMetadataRepository {
  putPending(
    tenantId: string,
    sessionId: string,
    fileKey: string,
    tracked: FileHistoryTrackedFile,
  ): Promise<boolean>;
  getPending(tenantId: string, sessionId: string): Promise<Record<string, FileHistoryTrackedFile>>;
  commitSnapshot(tenantId: string, sessionId: string, snapshot: FileHistorySnapshot): Promise<boolean>;
  listSnapshots(tenantId: string, sessionId: string): Promise<FileHistorySnapshot[]>;
  replaceSnapshots(tenantId: string, sessionId: string, snapshots: FileHistorySnapshot[]): Promise<void>;
  cleanup(tenantId: string, sessionId: string): Promise<void>;
}

export interface AsyncFileHistoryStore extends FileChangeHistoryPort {
  /** Records the object before its first edit in the current pending batch. */
  trackEdit(input: {
    sessionId: string;
    fileKey: string;
    original: Uint8Array | null;
    contentType?: string | null;
  }): Promise<void>;
  makeSnapshot(sessionId: string, messageSeq: number): Promise<string | null>;
  rewind(sessionId: string, targetSeq: number): Promise<FileHistoryRewindResult>;
  hasSnapshots(sessionId: string): Promise<boolean>;
  cleanup(sessionId: string): Promise<void>;
}
