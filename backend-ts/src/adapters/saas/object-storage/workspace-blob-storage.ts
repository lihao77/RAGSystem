import path from "node:path";

import type { ObjectStorage } from "../../../contracts/object-storage.js";
import type { DurableManagedSpace, WorkspaceBlobRef, WorkspaceBlobStorage } from "../../../contracts/workspace-blob-storage.js";

export class SaaSWorkspaceBlobStorage implements WorkspaceBlobStorage {
  constructor(private readonly tenantId: string, private readonly objects: ObjectStorage) {
    if (!tenantId.trim()) throw new Error("SaaS workspace blob storage requires a tenant id");
  }

  async put(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string; body: Uint8Array; contentType?: string | null }): Promise<WorkspaceBlobRef> {
    const ref = this.resolve(input);
    const metadata = await this.objects.put(ref.key, input.body, input.contentType ?? null);
    return { ...ref, content_type: metadata.contentType, size: metadata.contentLength };
  }

  async get(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string }): Promise<{ body: Uint8Array; ref: WorkspaceBlobRef } | null> {
    const ref = this.resolve(input);
    const result = await this.objects.get(ref.key);
    if (!result) return null;
    return { body: result.body, ref: { ...ref, content_type: result.metadata.contentType, size: result.metadata.contentLength } };
  }

  async delete(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string }): Promise<boolean> {
    return this.objects.delete(this.resolve(input).key);
  }

  private resolve(input: { sessionId: string; runId?: string | null; space: DurableManagedSpace; relativePath: string }): WorkspaceBlobRef {
    const sessionId = requireSegment(input.sessionId, "session id");
    const runId = input.runId == null ? null : requireSegment(input.runId, "run id");
    const relativePath = normalizeRelativePath(input.relativePath);
    const owner = runId ? `runs/${encodeURIComponent(runId)}` : "shared";
    return {
      key: `tenants/${encodeURIComponent(this.tenantId)}/sessions/${encodeURIComponent(sessionId)}/${owner}/${input.space}/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
      session_id: sessionId,
      run_id: runId,
      space: input.space,
      relative_path: relativePath,
      content_type: null,
      size: 0,
    };
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized)) throw new Error("workspace blob path must be relative");
  const canonical = path.posix.normalize(normalized);
  if (canonical === ".." || canonical.startsWith("../") || canonical.includes("/../")) throw new Error("workspace blob path escapes its managed space");
  return canonical.replace(/^\.\//, "");
}

function requireSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`workspace blob ${label} is required`);
  return normalized;
}
