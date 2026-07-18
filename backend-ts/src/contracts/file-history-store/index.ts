/**
 * file-history-store 行为契约（身份证的能力面）。
 *
 * 手写 IFileHistoryStore 照 FileHistoryService 的对外能力方法签名；内部辅助（getTracked /
 * backupFile / restoreFile / loadSnapshots / saveSnapshots / isSnapshot）是实现细节，不上契约。
 * 实现 FileHistoryService implements IFileHistoryStore，而非消费者依赖具体类。契约层零 import services。
 */
import type {
  FileHistoryRewindResult,
  FileHistorySnapshot,
  FileHistoryStoreOptions,
  FileHistoryTrackedFile,
} from "./types.js";

export * from "./types.js";
export * from "./async.js";

/**
 * file-history-store 对外能力（agent 编辑文件的快照与回退，支撑 rollback/retry）。
 *
 * 深合约：
 * - trackEdit 幂等：同一 session 同一文件仅首次编辑前备份原始内容（已存在文件备份 sha256 记 modified，
 *   新文件不备份记 created）；重复 trackEdit 同文件无副作用；备份 I/O 失败（磁盘满/权限）抛异常（同步 fs），
 *   非静默——消费者应在编辑前调用并处理异常，否则 rewind 时才发现无备份可还原；
 * - makeSnapshot 把当前 pending tracked 打包关联 messageSeq 后清空 pending，返回 snapshot_id；
 *   无 tracked 或非法 session/seq 返回 null（非抛异常）；
 * - rewind 按 message_seq 升序遍历还原：modified 恢复每个文件最早的备份内容、created 删除文件；
 *   清理被回退的快照；非法 session/seq 返回 success:false（前置违反）；无快照无 pending 返回 success:true
 *   （无可回退内容，视为无操作成功，非失败）；中途 restoreFile I/O 失败抛异常（非原子，可能留部分还原状态）；
 * - hasSnapshots / listSnapshots 非法 session 返回 false / 空数组；
 * - cleanup 删除 session 的全部快照与备份目录。
 */
export interface IFileHistoryStore {
  trackEdit(sessionId: string | null | undefined, filePath: string): void;
  makeSnapshot(sessionId: string | null | undefined, messageSeq: number): string | null;
  rewind(sessionId: string | null | undefined, targetSeq: number): FileHistoryRewindResult;
  hasSnapshots(sessionId: string | null | undefined): boolean;
  listSnapshots(sessionId: string | null | undefined): FileHistorySnapshot[];
  /**
   * 当前持久化的 pending trackEdit（本轮 Agent 改的、makeSnapshot 之前的）。
   * pending 落 pending.json（重启新进程从磁盘恢复），但进程内单实例 lazy 缓存——同进程多实例不互感知写入。
   * 无则 null。
   */
  getPendingTracked(sessionId: string | null | undefined): Record<string, FileHistoryTrackedFile> | null;
  readBackup(sessionId: string | null | undefined, backupHash: string | null | undefined): string | null;
  cleanup(sessionId: string | null | undefined): void;
}
