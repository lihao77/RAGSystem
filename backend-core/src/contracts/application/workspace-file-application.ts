export interface WorkspaceFileReadResult {
  status: "found" | "not_found" | "unsupported";
  body?: Uint8Array;
  contentType?: string | null;
  size?: number;
  path?: string;
  /**
   * 内容版本标识（本地 mtime+size / 对象存储 etag），不含引号。
   * 路由层据此生成 HTTP ETag 支持条件重验证；缺省时不参与 304 判定。
   */
  etag?: string | null;
}

export interface WorkspaceFileEntry {
  name: string;
  /** 工作空间内相对 posix 路径（目录含自身名称，根目录为 "."）。 */
  path: string;
  type: "file" | "directory";
  /** 仅文件条目有值；目录为 null。 */
  size: number | null;
}

export interface WorkspaceFileListResult {
  status: "ok" | "not_found" | "unsupported";
  entries: WorkspaceFileEntry[];
  /** 目录条目数超过上限被截断时为 true。 */
  truncated: boolean;
  reason?: string | null;
}

/**
 * Reads durable files from the session's shared workspace.
 *
 * 会话级方法以 session 绑定的 workspace 根（或未绑定时的会话目录）为权威；
 * 项目级方法（listWorkspaceEntries / readWorkspaceEntry）直接按 workspaceId 解析
 * 项目根目录，服务于"工作空间文件浏览器"——本地部署项目根是真实目录，
 * SaaS 无目录概念，返回 unsupported 由路由层映射 501。
 */
export interface WorkspaceFileApplication {
  read(sessionId: string, filePath: string): Promise<WorkspaceFileReadResult>;
  listWorkspaceEntries(workspaceId: string, directoryPath: string): Promise<WorkspaceFileListResult>;
  readWorkspaceEntry(workspaceId: string, filePath: string): Promise<WorkspaceFileReadResult>;
}
