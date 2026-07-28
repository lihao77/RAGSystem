export type DurableManagedSpace = "workspace" | "exports";

export interface WorkspaceBlobRef {
  key: string;
  session_id: string;
  run_id: string | null;
  space: DurableManagedSpace;
  relative_path: string;
  content_type: string | null;
  size: number;
}

/** Durable managed files. `transient` is intentionally excluded: it is instance-local scratch space. */
export interface WorkspaceBlobStorage {
  put(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string; body: Uint8Array; contentType?: string | null }): Promise<WorkspaceBlobRef>;
  get(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string }): Promise<{ body: Uint8Array; ref: WorkspaceBlobRef } | null>;
  delete(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string }): Promise<boolean>;
}

export interface EphemeralWorkspacePolicy {
  readonly space: "transient";
  readonly durable: false;
  readonly survivesRestart: false;
}

export const EPHEMERAL_WORKSPACE_POLICY: EphemeralWorkspacePolicy = Object.freeze({
  space: "transient",
  durable: false,
  survivesRestart: false,
});
