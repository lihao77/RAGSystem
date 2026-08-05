/**
 * file-history-store 数据契约（身份证的数据面）。
 *
 * 纯领域 DTO（interface）。**无 zod 输入边界**——调用方都是内部可信路径（DocumentTools trackEdit、
 * sessions application makeSnapshot/rewind），非 HTTP/工具外部输入；zod 边界留给外部输入
 * （对照其他文件型存储契约）。
 * 契约独立：本文件零 import adapters/services。
 */

export interface FileHistoryTrackedFile {
  backup_hash: string | null;
  action: "modified" | "created";
  /** Original object content type. Used by async SaaS restore; Local may omit it. */
  content_type?: string | null;
}

export interface FileHistorySnapshot {
  snapshot_id: string;
  message_seq: number;
  tracked_files: Record<string, FileHistoryTrackedFile>;
  created_at: string;
}

export interface FileHistoryRewindResult {
  success: boolean;
  message: string;
  reverted_files: number;
}

/** Minimal edit-history capability consumed by document tools. */
export interface FileEditHistoryPort {
  trackEdit(sessionId: string | null | undefined, filePath: string): void | Promise<void>;
}
