import type { UploadedFileRecord } from "../storage/files.js";

export interface AddSessionFileMetadataInput extends UploadedFileRecord {
  tenant_id: string;
}

export interface SessionFileMetadata extends UploadedFileRecord {
  tenant_id: string;
}

export interface SessionFileMetadataRepository {
  list(tenantId: string, sessionId: string): Promise<SessionFileMetadata[]>;
  get(tenantId: string, sessionId: string, fileId: string): Promise<SessionFileMetadata | null>;
  create(input: AddSessionFileMetadataInput): Promise<SessionFileMetadata>;
  delete(tenantId: string, sessionId: string, fileId: string): Promise<boolean>;
}

export interface AsyncSessionFileStorage {
  list(sessionId: string): Promise<UploadedFileRecord[]>;
  get(sessionId: string, fileId: string): Promise<UploadedFileRecord | null>;
  add(sessionId: string, input: { originalName: string; buffer: Uint8Array; mime: string }): Promise<UploadedFileRecord>;
  delete(sessionId: string, fileId: string): Promise<UploadedFileRecord | null>;
  read(sessionId: string, fileId: string): Promise<{ body: Uint8Array; contentType: string | null } | null>;
}

/** Deployment-neutral asynchronous lookup used by agent attachment resolution. */
export interface SessionFileLookupPort {
  get(sessionId: string, fileId: string): Promise<UploadedFileRecord | null>;
  read(sessionId: string, fileId: string): Promise<{ body: Uint8Array; contentType: string | null } | null>;
}
