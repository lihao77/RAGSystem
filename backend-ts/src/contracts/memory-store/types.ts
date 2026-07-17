/**
 * memory-store 数据契约（身份证的数据面）。
 *
 * 输入边界用 zod schema（SaveMemoryInput / MemoryScopeSpec），既给编译期类型，也给
 * saveMemory 入口运行时校验。输出/领域（MemoryEntry 等）用 interface。
 *
 * 契约独立：本文件零 import services，凡 IMemoryStore 签名引用的类型必在此定义。
 */
import { z } from "zod";

// ────────────────────────────── 共享枚举 / 作用域 ──────────────────────────────

export const MemoryScopeNameSchema = z.enum(["team", "session", "agent", "workspace", "user"]);
export type MemoryScopeName = z.infer<typeof MemoryScopeNameSchema>;

export const MemoryScopeSpecSchema = z.object({
  scope: MemoryScopeNameSchema,
  team_name: z.string().optional(),
  session_id: z.string().optional(),
  agent_name: z.string().optional(),
  workspace_key: z.string().optional(),
  user_id: z.string().optional(),
});
export type MemoryScopeSpec = z.infer<typeof MemoryScopeSpecSchema>;

// ────────────────────────────── 输入边界（zod schema + z.infer） ──────────────────────────────

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

// ────────────────────────────── 输出/领域（interface） ──────────────────────────────

export interface MemoryStoreOptions {
  dataRoot?: string | undefined;
}

export interface MemoryIndexReadOptions {
  maxLines?: number | undefined;
  maxChars?: number | undefined;
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
  created_at: string;
  updated_at: string;
  body: string;
}

export interface SavedMemoryFile {
  file_name: string;
  file_path: string;
  scope: MemoryScopeName;
}
