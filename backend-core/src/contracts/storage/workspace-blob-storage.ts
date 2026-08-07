export type DurableManagedSpace = "workspace";

export interface WorkspaceBlobRef {
  key: string;
  session_id: string;
  run_id: string | null;
  space: DurableManagedSpace;
  relative_path: string;
  content_type: string | null;
  size: number;
}

/** Durable managed files. System temporary files are intentionally excluded. */
export interface WorkspaceBlobStorage {
  put(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string; body: Uint8Array; contentType?: string | null }): Promise<WorkspaceBlobRef>;
  get(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string }): Promise<{ body: Uint8Array; ref: WorkspaceBlobRef } | null>;
  delete(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string }): Promise<boolean>;
}
