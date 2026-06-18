/**
 * file-index-store 行为契约（身份证的能力面）。
 *
 * 手写 IFileIndexStore 照 FileIndexService 的对外能力方法签名；内部辅助（nextFileId / initDatabase /
 * rowToFileRecord / matchesFilters）是实现细节，不上契约。实现 FileIndexService implements IFileIndexStore，
 * 而非消费者依赖具体类。契约层零 import services。
 */
import type { UploadedFileRecord } from "../files.js";
import type {
  AddFileInput,
  FileScopeType,
  FileIndexStoreOptions,
  ListFilesInput,
} from "./types.js";

export * from "./types.js";
// 输出 DTO 复用通用 file 契约；re-export 便于消费者一处 import（store 接口 + DTO）。
export { type UploadedFileRecord } from "../files.js";

/**
 * file-index-store 对外能力（上传文件元数据索引 + 物理 blob 存储）。
 *
 * 深合约：
 * - get / delete 不存在返回 null（非抛异常）；delete 只删元数据、不清理物理 blob（与 add 不对称：add
 *   收编 blob 写入；blob 删除留消费者用返回记录的 stored_path 另行 removeStoredFile，避免 store 误删 scope 外文件）；
 * - add 原子：store 负责 storedName（sanitize + randomBytes 防冲突）、storedPath（scope 决定根目录）、物理落盘、
 *   INSERT 元数据；INSERT 失败或读回失败回滚物理文件 + DB 行，不留孤儿 blob/行；
 *   深合约前置：session scope 必须提供 scopeId（否则抛错，防 sessions//uploads 路径退化污染）；
 * - list 按 uploaded_at 降序，可按 extensions / mimeTypes 过滤（并集 OR）；
 * - 物理根目录:session → getSessionUploadsRoot(scopeId);知识库文件已独立到 driver(kb_files),uploaded_files 只留会话附件;
 * - close 释放 SQLite 连接。
 */
export interface IFileIndexStore {
  list(input: ListFilesInput): UploadedFileRecord[];
  get(fileId: string, scopeType: FileScopeType, scopeId?: string | null): UploadedFileRecord | null;
  add(input: AddFileInput): UploadedFileRecord;
  delete(fileId: string, scopeType: FileScopeType, scopeId?: string | null): UploadedFileRecord | null;
  getSessionUploadsRoot(sessionId: string): string;
  close(): void;
}
