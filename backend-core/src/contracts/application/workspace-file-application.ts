export interface WorkspaceFileReadResult {
  status: "found" | "not_found";
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

/** Reads durable files from the session's shared workspace. */
export interface WorkspaceFileApplication {
  read(sessionId: string, filePath: string): Promise<WorkspaceFileReadResult>;
}
