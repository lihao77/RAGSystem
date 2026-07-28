import type {
  MemoryEntryFile,
  MemoryIndexReadOptions,
  MemoryScopeSpec,
  SaveMemoryInput,
  SavedMemoryFile,
} from "./types.js";

/** Promise-only persistence boundary used by memory tools. */
export interface MemoryToolRepositoryPort {
  loadIndexHead(scopeSpec: MemoryScopeSpec, options?: MemoryIndexReadOptions): Promise<string>;
  readEntryFile(scopeSpec: MemoryScopeSpec, fileName: string): Promise<MemoryEntryFile | null>;
  saveMemory(input: SaveMemoryInput): Promise<SavedMemoryFile>;
  archiveMemory(scopeSpec: MemoryScopeSpec, fileName: string): Promise<boolean>;
  getIndexPath?(scopeSpec: MemoryScopeSpec): Promise<string | null>;
}
