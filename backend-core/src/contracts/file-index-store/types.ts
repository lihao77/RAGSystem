/**
 * file-index-store 数据契约（身份证的数据面）。
 *
 * 输入边界用 zod schema（AddFileInput / ListFilesInput），既给编译期类型，也给 add 入口运行时校验。
 * 上传是 HTTP 外部输入 → zod 边界必要（对照 file-history 内部调用不 zod，见"何时该 zod"判据）。
 * 输出 DTO UploadedFileRecord 复用通用 contracts/storage/files.js（契约层跨模块依赖合规，对齐
 * conversation-store/types.ts 之 import contracts/session + common）。
 * 契约独立：本文件零 import adapters/services，Local 文件索引与共享 application Port 复用这些 DTO。
 */
import { z } from "zod";

// ────────────────────────────── 作用域 ──────────────────────────────

export const FileScopeTypeSchema = z.enum(["session"]);
export type FileScopeType = z.infer<typeof FileScopeTypeSchema>;

// ────────────────────────────── 输入边界（zod schema + z.infer） ──────────────────────────────

export const ListFilesInputSchema = z.object({
  scopeType: FileScopeTypeSchema,
  scopeId: z.string().nullable().optional(),
  extensions: z.array(z.string()).optional(),
  mimeTypes: z.array(z.string()).optional(),
});
export type ListFilesInput = z.infer<typeof ListFilesInputSchema>;

// NOTE：不要改用 z.infer<typeof AddFileInputSchema> 推断 AddFileInput——z.instanceof(Uint8Array) 的
// z.infer 为 Uint8Array<ArrayBuffer>，过窄，Node Buffer<ArrayBufferLike> 无法赋值。见下方手写 AddFileInput。
export const AddFileInputSchema = z.object({
  originalName: z.string(),
  // 运行时校验 Uint8Array（Node multipart 的 Buffer 是其子类，通过）；收编后 store 负责 blob 落盘。
  buffer: z.instanceof(Uint8Array),
  mime: z.string(),
  scopeType: FileScopeTypeSchema,
  scopeId: z.string().nullable().optional(),
});
// 手写类型（不直接 z.infer）：buffer 用裸 Uint8Array（= Uint8Array<ArrayBufferLike>）以兼容 Node Buffer。
// z.instanceof(Uint8Array) 的 z.infer 推断为 Uint8Array<ArrayBuffer>，过窄，Buffer<ArrayBufferLike> 无法赋值。
export interface AddFileInput {
  originalName: string;
  buffer: Uint8Array;
  mime: string;
  scopeType: FileScopeType;
  scopeId?: string | null;
}
