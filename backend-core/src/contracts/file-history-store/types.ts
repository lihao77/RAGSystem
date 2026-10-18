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
  /** Original object content type. Used by async restore; filesystem storage may omit it. */
  content_type?: string | null;
  /**
   * 追踪时刻会话已落库的最大消息 seq。rewind 只冲刷 tracked_seq >= targetSeq 的 pending 条目
   * （编辑发生在锚点之后才该被回退）；缺省（历史存量/无法取 seq）= 不冲刷，留给下个快照边界归档。
   */
  tracked_seq?: number | null;
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
