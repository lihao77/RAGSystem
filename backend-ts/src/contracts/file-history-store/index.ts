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
} from "./types.js";

export * from "./types.js";

/**
 * file-history-store 对外能力（agent 编辑文件的快照与回退，支撑 rollback/retry）。
 *
 * 深合约：
 * - trackEdit 幂等：同一 session 同一文件仅首次编辑前备份原始内容（已存在文件备份 sha256 记 modified，
 *   新文件不备份记 created）；重复 trackEdit 同文件无副作用；
 * - makeSnapshot 把当前 pending tracked 打包关联 messageSeq 后清空 pending，返回 snapshot_id；
 *   无 tracked 或非法 session/seq 返回 null（非抛异常）；
 * - rewind 按 message_seq > targetSeq 降序还原：modified 恢复备份内容、created 删除文件；
 *   清理被回退的快照；非法 session/seq 返回失败结果（非抛异常）；
 * - hasSnapshots / listSnapshots 非法 session 返回 false / 空数组；
 * - cleanup 删除 session 的全部快照与备份目录。
 */
export interface IFileHistoryStore {
  trackEdit(sessionId: string | null | undefined, filePath: string): void;
  makeSnapshot(sessionId: string | null | undefined, messageSeq: number): string | null;
  rewind(sessionId: string | null | undefined, targetSeq: number): FileHistoryRewindResult;
  hasSnapshots(sessionId: string | null | undefined): boolean;
  listSnapshots(sessionId: string | null | undefined): FileHistorySnapshot[];
  cleanup(sessionId: string | null | undefined): void;
}
