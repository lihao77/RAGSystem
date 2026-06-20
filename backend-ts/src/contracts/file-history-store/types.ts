/**
 * file-history-store 数据契约（身份证的数据面）。
 *
 * 纯领域 DTO（interface）。**无 zod 输入边界**——调用方都是内部可信路径（DocumentTools trackEdit、
 * sessions application makeSnapshot/rewind），非 HTTP/工具外部输入；zod 边界留给外部输入
 * （对照 memory-store / file-index-store）。沉淀判据：外部输入边界（HTTP/工具）才 zod，
 * 内部 store 调用用 interface 契约即可。
 * 契约独立：本文件零 import services。
 */

export interface FileHistoryTrackedFile {
  backup_hash: string | null;
  action: "modified" | "created";
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

export interface FileHistoryStoreOptions {
  dataRoot?: string | undefined;
}
