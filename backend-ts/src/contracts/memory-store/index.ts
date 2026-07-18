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
import type {
  PersistedMemoryEntry,
  PersistedMemoryManagementArchiveInput,
  PersistedMemoryManagementArchiveResult,
  PersistedMemoryManagementCountOptions,
  PersistedMemoryManagementListOptions,
  PersistedMemoryManagementLookupInput,
  PersistedMemoryManagementResolvedEntry,
} from "./persistence-types.js";

export * from "./types.js";
export * from "./persistence-types.js";
export type { TransactionalMemoryRepository } from "./transactional-repository.js";
export { getWorkspaceMemoryKey } from "./scope.js";

/**
 * memory-store 对外能力（文件系统持久化的多作用域记忆）。
 *
 * 深合约：
 * - readEntryFile / archiveMemory 不存在返回 null / false（非抛异常）；
 * - loadIndexHead 先 ensureScope（首次建默认索引），返回索引头；仅 IO 异常返回空串；
 * - saveMemory 幂等（同名文件覆盖 + 重建 MEMORY.md 索引）；memory_type 非白名单抛错；
 * - listEntries 按 updated_at 降序，默认仅 active。
 */
export interface MemoryIndexReader {
  loadIndexHead(scopeSpec: MemoryScopeSpec, options?: MemoryIndexReadOptions): string;
}

/**
 * 可选的 scope 版本读取能力，用于让上下文缓存感知 memory 变更。
 *
 * revision 只要求在同一 scope 内容变化后改变；具体实现可使用递增整数、时间戳或 opaque token。
 */
export interface MemoryScopeRevisionReader {
  getScopeRevision(scopeSpec: MemoryScopeSpec): string | number;
}

/** Deployment-neutral management listing used by the Memory manager UI. */
export interface MemoryManagementReader {
  listManagedEntries(options: PersistedMemoryManagementListOptions): PersistedMemoryEntry[];
  countManagedEntries(options: PersistedMemoryManagementCountOptions): number;
  getManagedEntry(input: PersistedMemoryManagementLookupInput): PersistedMemoryManagementResolvedEntry | null;
  archiveManagedEntry(input: PersistedMemoryManagementArchiveInput): Promise<PersistedMemoryManagementArchiveResult>;
}

/** 部署无关的 memory 持久化能力；消费者应优先依赖此接口。 */
export interface MemoryRepository extends MemoryIndexReader {
  readEntryFile(scopeSpec: MemoryScopeSpec, fileName: string): MemoryEntryFile | null;
  saveMemory(input: SaveMemoryInput): Promise<SavedMemoryFile>;
  listEntries(scopeSpec: MemoryScopeSpec, options?: { includeArchived?: boolean | undefined }): MemoryEntry[];
  archiveMemory(scopeSpec: MemoryScopeSpec, fileName: string): Promise<boolean>;
  saveMemoryWithCommit(
    input: SaveMemoryInput,
    commit: (saved: SavedMemoryFile) => boolean | Promise<boolean>,
  ): Promise<SavedMemoryFile>;
  archiveMemoryWithCommit(
    scopeSpec: MemoryScopeSpec,
    fileName: string,
    commit: () => boolean | Promise<boolean>,
  ): Promise<boolean>;
}

/** Local 文件实现提供的可选诊断位置，不属于 memory 领域能力。 */
export interface MemoryRepositoryLocationProvider {
  getIndexPath(scopeSpec: MemoryScopeSpec): string;
}

/** @deprecated 新消费者使用 MemoryRepository；保留给现有 Local 调用方兼容。 */
export interface IMemoryStore extends MemoryRepository, MemoryRepositoryLocationProvider, MemoryManagementReader {}
