import type { UploadedFileRecord } from "../storage/files.js";

export type Awaitable<T> = T | Promise<T>;

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
  list(sessionId: string): Awaitable<UploadedFileRecord[]>;
  validate(sessionId: string, fileIds: readonly string[]): Awaitable<SessionFileValidationResult>;
  add(sessionId: string, input: {
    originalName: string;
    buffer: Uint8Array;
    mime: string;
  }): Awaitable<UploadedFileRecord>;
  get(sessionId: string, fileId: string): Awaitable<UploadedFileRecord | null>;
  delete(sessionId: string, fileId: string): Awaitable<UploadedFileRecord | null>;
  read(sessionId: string, fileId: string): Awaitable<SessionFileReadResult>;
}
