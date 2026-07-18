import fs from "node:fs";
import path from "node:path";

import type { FastifyReply, FastifyRequest } from "fastify";

import type { IFileIndexStore } from "../contracts/file-index-store/index.js";
import { HttpError } from "../utils/errors.js";

export interface FileScope {
  scopeType: "session";
  scopeId?: string | null;
}

export function parseCsvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface MultipartFile {
  filename: string;
  buffer: Buffer;
  mime: string;
}

/** 下载/删除时引用已存储文件的最小结构(uploaded_files 行 / kb_files 行均结构兼容)。 */
export interface StoredFileRef {
  stored_path: string;
  original_name: string;
  mime?: string | null;
}

/**
 * 收集 multipart/form-data 中的全部文件为内存 buffer(纯解析,与 store 解耦)。
 * 物理 blob 落盘由调用方各自调 store.add(IFileIndexStore session 附件 / IKnowledgeFileStore 知识库)。
 */
export async function collectMultipartFiles(request: FastifyRequest): Promise<MultipartFile[]> {
  if (!request.isMultipart()) {
    throw new HttpError(400, "invalid_request", "请求必须使用 multipart/form-data");
  }
  const collected: MultipartFile[] = [];
  for await (const part of request.files()) {
    if (!part.filename) {
      continue;
    }
    collected.push({ filename: part.filename, buffer: await part.toBuffer(), mime: part.mimetype ?? "" });
  }
  if (collected.length === 0) {
    throw new HttpError(400, "invalid_request", "未选择文件");
  }
  return collected;
}

export function validateFileIds(input: {
  fileIndex: IFileIndexStore;
  fileIds: string[];
  scope: FileScope;
}): { success: true; valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const fileId of input.fileIds) {
    const record = input.fileIndex.get(fileId, input.scope.scopeType, input.scope.scopeId ?? null);
    if (record) {
      valid.push(fileId);
    } else {
      invalid.push(fileId);
    }
  }
  return { success: true, valid, invalid };
}

export async function removeStoredFile(record: StoredFileRef, expectedRoot: string): Promise<void> {
  const storedPath = path.resolve(record.stored_path);
  if (!isPathUnder(storedPath, expectedRoot)) {
    return;
  }
  try {
    const stats = await fs.promises.stat(storedPath);
    if (stats.isFile()) {
      await fs.promises.unlink(storedPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function sendFileDownload(input: {
  record: StoredFileRef;
  expectedRoot: string;
  reply: FastifyReply;
}): Promise<FastifyReply> {
  const storedPath = path.resolve(input.record.stored_path);
  if (!isPathUnder(storedPath, input.expectedRoot)) {
    throw new HttpError(404, "not_found", "文件不存在于磁盘");
  }
  try {
    const stats = await fs.promises.stat(storedPath);
    if (!stats.isFile()) {
      throw new HttpError(404, "not_found", "文件不存在于磁盘");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "not_found", "文件不存在于磁盘");
    }
    throw error;
  }

  const filename = input.record.original_name || path.basename(storedPath);
  input.reply.header("content-type", resolveContentType(input.record.mime));
  input.reply.header("content-disposition", buildContentDisposition(filename));
  return input.reply.send(fs.createReadStream(storedPath));
}

export function sendBufferedFileDownload(input: {
  body: Uint8Array;
  filename: string;
  mime?: string | null;
  reply: FastifyReply;
}): FastifyReply {
  input.reply.header("content-type", resolveContentType(input.mime));
  input.reply.header("content-disposition", buildContentDisposition(input.filename));
  return input.reply.send(Buffer.from(input.body));
}

/**
 * content-type：仅接受无参数的 type/subtype（RFC 7231 token 形式）。mime 来自上传 multipart（客户端可控），
 * 含 CRLF/非 ASCII/畸形 token 会触发 node ERR_INVALID_CHAR → 500，非法一律回退 octet-stream。
 */
function resolveContentType(mime: string | null | undefined): string {
  const candidate = mime?.trim() ?? "";
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(candidate) ? candidate : "application/octet-stream";
}

/**
 * content-disposition: attachment。非 ASCII 文件名走 RFC 5987 filename*（percent-encoded UTF-8），
 * 同时给 ASCII fallback（filename=）兼容老客户端。直接把中文塞进 header 会触发 node ERR_INVALID_CHAR → 500。
 */
function buildContentDisposition(filename: string): string {
  const fallback = sanitizeHeaderFilename(filename);
  try {
    // encodeURIComponent 不编码 !'()*，这些非 RFC 5987 attr-char，额外百分号编码以严格合规
    const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  } catch {
    // 孤立 UTF-16 surrogate 会让 encodeURIComponent 抛 URIError；退回仅 ASCII fallback（DB 污染/异常数据防御）
    return `attachment; filename="${fallback}"`;
  }
}

function sanitizeHeaderFilename(filename: string): string {
  // header 值仅允许 ASCII 可见字符；非 ASCII（中文等）由 filename* 承载此处全去。引号/反斜杠会破坏 filename="..." 定界，替换为下划线
  return filename.replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "_").trim() || "file";
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
