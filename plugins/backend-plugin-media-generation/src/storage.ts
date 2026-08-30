import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { isAbsolutePathLike, resolvePathLike } from "@ragsystem/backend-core/tools/shared/paths.js";

/**
 * 生成产物转存：厂商 URL 有效期 1h～24h，所有产物必须立即下载落盘到会话工作区，
 * 前端经 /workspace-files/content 通道按 file_ref 展示。
 */

export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function imageExtensionForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "image/png": return ".png";
    default: return ".png";
  }
}

export function videoExtensionForMime(mime: string): string {
  switch (mime) {
    case "video/webm": return ".webm";
    case "video/quicktime": return ".mov";
    case "video/mp4": return ".mp4";
    default: return ".mp4";
  }
}

/** 判断候选路径是否落在 workspace 之外（用于界外产物的文案分流；不涉及审批状态）。 */
export function isPathOutsideWorkspace(base: string, candidate: string): boolean {
  const root = path.resolve(base);
  const resolved = isAbsolutePathLike(candidate) ? resolvePathLike(candidate) : path.resolve(root, candidate);
  const rel = path.relative(root, resolved);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

export function resolveWorkspaceRelative(
  base: string,
  relative: string,
  pathService?: PathAccessPolicy,
): { ok: true; absolutePath: string } | { ok: false; error: string } {
  const root = path.resolve(base);
  const candidate = isAbsolutePathLike(relative)
    ? resolvePathLike(relative)
    : path.resolve(root, relative.replaceAll("\\", "/"));
  const rel = path.relative(root, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // 写语义：界内仅 workspace；界外需经过路径审批（assertWithin 放行或抛错）
    if (!pathService) return { ok: false, error: `路径必须位于工作区内: ${relative}` };
    try {
      return { ok: true, absolutePath: pathService.assertWithin(candidate, [root], relative) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true, absolutePath: candidate };
}

export interface PersistMediaInput {
  workspaceRoot: string;
  /** 工作区相对目录（如 media/images）；默认 media。界外绝对路径需经路径审批。 */
  outputDir: string;
  /** 文件名前缀（img_/vid_/cover_）。 */
  baseName: string;
  bytes: Buffer;
  /** 文件扩展名（含点）。 */
  ext: string;
  pathService?: PathAccessPolicy | null;
}

export interface PersistedMedia {
  /** 工作区相对路径（正斜杠，供 file_ref 引用）；界外产物回退为绝对路径（无法内嵌展示）。 */
  relativePath: string;
  absolutePath: string;
  size: number;
}

export async function persistMediaFile(input: PersistMediaInput): Promise<PersistedMedia> {
  const dirCheck = resolveWorkspaceRelative(input.workspaceRoot, input.outputDir || "media", input.pathService ?? undefined);
  if (!dirCheck.ok) throw new Error(dirCheck.error);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const fileName = `${input.baseName}_${stamp}_${suffix}${input.ext}`;
  const absolutePath = path.join(dirCheck.absolutePath, fileName);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, input.bytes);
  const rel = path.relative(path.resolve(input.workspaceRoot), absolutePath).replaceAll("\\", "/");
  // 审批放行的界外产物无法用工作区相对路径表达，回退为绝对路径
  return { relativePath: rel.startsWith("..") ? absolutePath.replaceAll("\\", "/") : rel, absolutePath, size: input.bytes.length };
}

/** 媒体 mime 归一（厂商 content-type 可能带 charset 或大写）。 */
export function normalizeMediaMime(mime: string, fallback: string): string {
  const normalized = String(mime ?? "").trim().toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized.startsWith("image/") || normalized.startsWith("video/")) return normalized;
  return fallback;
}
