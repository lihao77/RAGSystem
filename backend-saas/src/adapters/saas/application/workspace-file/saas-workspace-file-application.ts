import type { WorkspaceFileApplication, WorkspaceFileReadResult } from "@ragsystem/backend-core/contracts/application/workspace-file-application.js";
import type { WorkspaceBlobStorage } from "@ragsystem/backend-core/contracts/storage/workspace-blob-storage.js";

export class SaaSWorkspaceFileApplication implements WorkspaceFileApplication {
  constructor(private readonly blobs: WorkspaceBlobStorage) {}

  async read(sessionId: string, filePath: string): Promise<WorkspaceFileReadResult> {
    const result = await this.blobs.get({ sessionId, space: "workspace", relativePath: stripWorkspacePrefix(filePath) });
    if (!result) return { status: "not_found" };
    return {
      status: "found",
      body: result.body,
      contentType: result.ref.content_type,
      size: result.ref.size,
      path: result.ref.relative_path,
    };
  }
}

function stripWorkspacePrefix(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.replace(/^workspace\//i, "");
}
