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

  const filename = sanitizeHeaderFilename(input.record.original_name || path.basename(storedPath));
  input.reply.header("content-type", "application/octet-stream");
  input.reply.header("content-disposition", `attachment; filename="${filename}"`);
  return input.reply.send(fs.createReadStream(storedPath));
}

function sanitizeHeaderFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, "_");
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
