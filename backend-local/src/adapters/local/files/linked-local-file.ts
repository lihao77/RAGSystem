import { createHash } from "node:crypto";
import fs from "node:fs";

import type { UploadedFileRecord } from "@ragsystem/backend-core/contracts/storage/files.js";

export interface LinkedLocalFileSnapshot {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** Capture metadata and content hash from one stable view of a local file. */
export async function captureLinkedLocalFileSnapshot(filePath: string): Promise<LinkedLocalFileSnapshot> {
  const before = await fs.promises.stat(filePath);
  if (!before.isFile()) throw new Error("本地链接路径不是文件");
  const sha256 = await sha256File(filePath);
  const after = await fs.promises.stat(filePath);
  if (!sameFileVersion(before, after)) {
    throw new Error("本地文件在登记期间发生变化，请重试");
  }
  return { size: after.size, mtimeMs: after.mtimeMs, sha256 };
}

/** Verify both cheap metadata and the persisted content fingerprint. */
export async function isCurrentLinkedLocalRecord(record: UploadedFileRecord): Promise<boolean> {
  if (record.storage_kind !== "linked_local") return true;
  if (!hasCompleteFingerprint(record)) return false;
  try {
    const before = await fs.promises.stat(record.local_path);
    if (!matchesMetadata(record, before)) return false;
    const sha256 = await sha256File(record.local_path);
    const after = await fs.promises.stat(record.local_path);
    return sameFileVersion(before, after)
      && matchesMetadata(record, after)
      && sha256 === record.source_sha256;
  } catch {
    return false;
  }
}

/** Read and verify a linked file once, avoiding a separate full hashing pass. */
export async function readCurrentLinkedLocalFile(record: UploadedFileRecord): Promise<Uint8Array | null> {
  if (!hasCompleteFingerprint(record)) return null;
  try {
    const before = await fs.promises.stat(record.local_path);
    if (!matchesMetadata(record, before)) return null;
    const body = await fs.promises.readFile(record.local_path);
    const after = await fs.promises.stat(record.local_path);
    if (!sameFileVersion(before, after) || !matchesMetadata(record, after)) return null;
    return sha256Bytes(body) === record.source_sha256 ? body : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hasCompleteFingerprint(record: UploadedFileRecord): record is UploadedFileRecord & {
  local_path: string;
  source_mtime_ms: number;
  source_sha256: string;
} {
  return record.storage_kind === "linked_local"
    && typeof record.local_path === "string"
    && record.local_path.length > 0
    && typeof record.source_mtime_ms === "number"
    && Number.isFinite(record.source_mtime_ms)
    && typeof record.source_sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(record.source_sha256);
}

function matchesMetadata(
  record: UploadedFileRecord & { source_mtime_ms: number },
  stats: fs.Stats,
): boolean {
  return stats.isFile() && stats.size === record.size && stats.mtimeMs === record.source_mtime_ms;
}

function sameFileVersion(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sha256Bytes(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
