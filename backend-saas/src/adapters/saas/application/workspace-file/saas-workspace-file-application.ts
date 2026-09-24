import type {
  WorkspaceFileApplication,
  WorkspaceFileListResult,
  WorkspaceFileReadResult,
} from "@ragsystem/backend-core/contracts/application/workspace-file-application.js";
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
      etag: result.ref.etag ?? null,
    };
  }

  // SaaS 的项目没有本地根目录（root_path 为 null），工作区文件只按会话落在对象存储，
  // 目录浏览语义无处安放；显式返回 unsupported，由路由层映射 501 而非假装空目录。
  async listWorkspaceEntries(): Promise<WorkspaceFileListResult> {
    return { status: "unsupported", entries: [], truncated: false, reason: "SaaS 部署暂不支持项目文件浏览" };
  }

  async readWorkspaceEntry(): Promise<WorkspaceFileReadResult> {
    return { status: "unsupported" };
  }
}

function stripWorkspacePrefix(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.replace(/^workspace\//i, "");
}
