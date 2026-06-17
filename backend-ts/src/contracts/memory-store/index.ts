/**
 * memory-store 行为契约（身份证的能力面）。
 *
 * 手写 IMemoryStore 照 MemoryStore 的对外能力方法签名；内部辅助（getScopeRoot /
 * ensureScope）是实现细节，不上契约。实现 MemoryStore implements IMemoryStore，
 * 而非消费者依赖具体类。契约层零 import services。
 */
import type {
  MemoryEntry,
  MemoryEntryFile,
  MemoryIndexReadOptions,
  MemoryScopeSpec,
  SaveMemoryInput,
  SavedMemoryFile,
} from "./types.js";

export * from "./types.js";

/**
 * memory-store 对外能力（文件系统持久化的多作用域记忆）。
 *
 * 深合约：
 * - readEntryFile / archiveMemory 不存在返回 null / false（非抛异常）；
 * - loadIndexHead 先 ensureScope（首次建默认索引），返回索引头；仅 IO 异常返回空串；
 * - saveMemory 幂等（同名文件覆盖 + 重建 MEMORY.md 索引）；memory_type 非白名单抛错；
 * - listEntries 按 updated_at 降序，默认仅 active。
 */
export interface IMemoryStore {
  loadIndexHead(scopeSpec: MemoryScopeSpec, options?: MemoryIndexReadOptions): string;
  getIndexPath(scopeSpec: MemoryScopeSpec): string;
  readEntryFile(scopeSpec: MemoryScopeSpec, fileName: string): MemoryEntryFile | null;
  saveMemory(input: SaveMemoryInput): SavedMemoryFile;
  listEntries(scopeSpec: MemoryScopeSpec, options?: { includeArchived?: boolean | undefined }): MemoryEntry[];
  archiveMemory(scopeSpec: MemoryScopeSpec, fileName: string): boolean;
}
