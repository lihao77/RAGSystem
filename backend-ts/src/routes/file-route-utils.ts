import fs from "node:fs";
import path from "node:path";

import type { FastifyReply, FastifyRequest } from "fastify";

import type { IFileIndexStore } from "../contracts/file-index-store/index.js";
import type { UploadedFileRecord } from "../contracts/files.js";
import { HttpError } from "../utils/errors.js";

export interface FileScope {
  scopeType: "global" | "session";
  scopeId?: string | null;
}

export function parseCsvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function uploadMultipartFiles(input: {
  request: FastifyRequest;
  fileIndex: IFileIndexStore;
  scope: FileScope;
}): Promise<UploadedFileRecord[]> {
  if (!input.request.isMultipart()) {
    throw new HttpError(400, "invalid_request", "请求必须使用 multipart/form-data");
  }

  // 物理 blob 落盘已收编进 store.add（消除原 route 层裸 fs.writeFile 与元数据登记的非原子）
  const created: UploadedFileRecord[] = [];
  for await (const part of input.request.files()) {
    if (!part.filename) {
      continue;
    }
    const buffer = await part.toBuffer();
    created.push(
      input.fileIndex.add({
        originalName: part.filename,
        buffer,
        mime: part.mimetype ?? "",
        scopeType: input.scope.scopeType,
        scopeId: input.scope.scopeId ?? null,
      }),
    );
  }

  if (created.length === 0) {
    throw new HttpError(400, "invalid_request", "未选择文件");
  }
  return created;
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

export async function removeStoredFile(record: UploadedFileRecord, expectedRoot: string): Promise<void> {
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
  record: UploadedFileRecord;
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
