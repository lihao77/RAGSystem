import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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

export function resolveWorkspaceRelative(base: string, relative: string): { ok: true; absolutePath: string } | { ok: false; error: string } {
  const root = path.resolve(base);
  const candidate = path.resolve(root, relative.replaceAll("\\", "/"));
  const rel = path.relative(root, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: `路径必须位于工作区内: ${relative}` };
  }
  return { ok: true, absolutePath: candidate };
}

export interface PersistMediaInput {
  workspaceRoot: string;
  /** 工作区相对目录（如 media/images）；默认 media。 */
  outputDir: string;
  /** 文件名前缀（img_/vid_/cover_）。 */
  baseName: string;
  bytes: Buffer;
  /** 文件扩展名（含点）。 */
  ext: string;
}

export interface PersistedMedia {
  /** 工作区相对路径（正斜杠，供 file_ref 引用）。 */
  relativePath: string;
  absolutePath: string;
  size: number;
}

export async function persistMediaFile(input: PersistMediaInput): Promise<PersistedMedia> {
  const dirCheck = resolveWorkspaceRelative(input.workspaceRoot, input.outputDir || "media");
  if (!dirCheck.ok) throw new Error(dirCheck.error);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const fileName = `${input.baseName}_${stamp}_${suffix}${input.ext}`;
  const absolutePath = path.join(dirCheck.absolutePath, fileName);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, input.bytes);
  const relativePath = path.relative(path.resolve(input.workspaceRoot), absolutePath).replaceAll("\\", "/");
  return { relativePath, absolutePath, size: input.bytes.length };
}

/** 媒体 mime 归一（厂商 content-type 可能带 charset 或大写）。 */
export function normalizeMediaMime(mime: string, fallback: string): string {
  const normalized = String(mime ?? "").trim().toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized.startsWith("image/") || normalized.startsWith("video/")) return normalized;
  return fallback;
}
