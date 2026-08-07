export interface WorkspaceFileReadResult {
  status: "found" | "not_found";
  body?: Uint8Array;
  contentType?: string | null;
  size?: number;
  path?: string;
}

/** Reads durable files from the session's shared workspace. */
export interface WorkspaceFileApplication {
  read(sessionId: string, filePath: string): Promise<WorkspaceFileReadResult>;
}
