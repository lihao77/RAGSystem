import type { UploadedFileRecord } from "../storage/files.js";

export interface SessionFileValidationResult {
  valid: string[];
  invalid: string[];
}

export type SessionFileReadResult =
  | { status: "found"; record: UploadedFileRecord; body: Uint8Array; contentType: string | null }
  | { status: "not_found" }
  | { status: "content_missing" };

/** Deployment-neutral session attachment use cases consumed by HTTP routes. */
export interface SessionFileApplication {
  list(sessionId: string): Promise<UploadedFileRecord[]>;
  validate(sessionId: string, fileIds: readonly string[]): Promise<SessionFileValidationResult>;
  add(sessionId: string, input: {
    originalName: string;
    buffer: Uint8Array;
    mime: string;
  }): Promise<UploadedFileRecord>;
  get(sessionId: string, fileId: string): Promise<UploadedFileRecord | null>;
  delete(sessionId: string, fileId: string): Promise<UploadedFileRecord | null>;
  read(sessionId: string, fileId: string): Promise<SessionFileReadResult>;
}
