/**
 * memory 数据契约（迁自 backend-ts contracts/memory-store/types.ts）。
 * 纯类型 + zod schema（saveMemory 入口校验）。
 */
import { z } from "zod";

export const MemoryScopeNameSchema = z.enum(["team", "session", "agent", "workspace"]);
export type MemoryScopeName = z.infer<typeof MemoryScopeNameSchema>;

export const MemoryScopeSpecSchema = z.object({
  scope: MemoryScopeNameSchema,
  team_name: z.string().optional(),
  session_id: z.string().optional(),
  agent_name: z.string().optional(),
  workspace_key: z.string().optional(),
});
export type MemoryScopeSpec = z.infer<typeof MemoryScopeSpecSchema>;

export const SaveMemoryInputSchema = MemoryScopeSpecSchema.extend({
  name: z.string(),
  description: z.string(),
  memory_type: z.string(),
  content: z.string(),
  why: z.string().nullable().optional(),
  how_to_apply: z.string().nullable().optional(),
  source_run_id: z.string().nullable().optional(),
  source_message_id: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});
export type SaveMemoryInput = z.infer<typeof SaveMemoryInputSchema>;

export interface MemoryStoreOptions {
  dataRoot?: string;
}

export interface MemoryIndexReadOptions {
  maxLines?: number;
  maxChars?: number;
}

export interface MemoryEntryFile {
  scope: MemoryScopeName;
  file_name: string;
  file_path: string;
  content: string;
}

export interface MemoryEntry {
  name: string;
  description: string;
  scope: MemoryScopeName;
  memory_type: string;
  status: string;
  file_name: string;
  file_path: string;
  updated_at: string;
  body: string;
}

export interface SavedMemoryFile {
  file_name: string;
  file_path: string;
  scope: MemoryScopeName;
}

export interface IMemoryStore {
  getScopeRoot(scopeSpec: MemoryScopeSpec): string;
  getIndexPath(scopeSpec: MemoryScopeSpec): string;
  ensureScope(scopeSpec: MemoryScopeSpec): string;
  loadIndexHead(scopeSpec: MemoryScopeSpec, options?: MemoryIndexReadOptions): string;
  readEntryFile(scopeSpec: MemoryScopeSpec, fileName: string): MemoryEntryFile | null;
  saveMemory(input: SaveMemoryInput): SavedMemoryFile;
  listEntries(scopeSpec: MemoryScopeSpec, options?: { includeArchived?: boolean }): MemoryEntry[];
  archiveMemory(scopeSpec: MemoryScopeSpec, fileName: string): boolean;
}
