import path from "node:path";

import type { AsyncSessionFileStorage } from "@ragsystem/backend-core/contracts/session/session-file-storage.js";
import type { SandboxDriver, SandboxLease, SandboxLeaseLifecycle, SandboxOwner } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import type { UploadedFileRecord } from "@ragsystem/backend-core/contracts/storage/files.js";

const MiB = 1024 * 1024;

export interface SandboxFileTransferLimits {
  maxInputFiles: number;
  maxInputFileBytes: number;
  maxInputTotalBytes: number;
  maxOutputFiles: number;
  maxOutputFileBytes: number;
  maxOutputTotalBytes: number;
}

export const DEFAULT_SANDBOX_FILE_TRANSFER_LIMITS: SandboxFileTransferLimits = {
  maxInputFiles: 32,
  maxInputFileBytes: 25 * MiB,
  maxInputTotalBytes: 100 * MiB,
  maxOutputFiles: 32,
  maxOutputFileBytes: 25 * MiB,
  maxOutputTotalBytes: 100 * MiB,
};

/** Backend-mediated file transfer. Object-storage credentials never enter the sandbox. */
export class SaaSSandboxFileBridge implements SandboxLeaseLifecycle {
  private readonly limits: SandboxFileTransferLimits;

  constructor(
    private readonly files: AsyncSessionFileStorage,
    limits: Partial<SandboxFileTransferLimits> = {},
  ) {
    this.limits = validateLimits({ ...DEFAULT_SANDBOX_FILE_TRANSFER_LIMITS, ...limits });
  }

  async prepare(
    lease: SandboxLease,
    owner: SandboxOwner,
    driver: SandboxDriver,
    input: { attachmentFileIds: readonly string[] },
  ): Promise<void> {
    const requestedIds = new Set(input.attachmentFileIds);
    const listedRecords = await this.files.list(owner.sessionId);
    const records = listedRecords.filter((record) => requestedIds.has(record.id));
    if (records.length !== requestedIds.size) {
      const found = new Set(records.map((record) => record.id));
      const missing = [...requestedIds].filter((fileId) => !found.has(fileId));
      throw new Error(`Sandbox input attachment is missing from the current session: ${missing.join(", ")}`);
    }
    if (records.length > this.limits.maxInputFiles) {
      throw new Error(`Sandbox input file count exceeds limit ${this.limits.maxInputFiles}`);
    }
    validateInputMetadata(records, owner, this.limits);

    const manifest: Array<Record<string, unknown>> = [];
    const usedNames = new Set<string>();
    let transferredBytes = 0;
    for (const record of records) {
      const file = await this.files.read(owner.sessionId, record.id);
      if (!file) throw new Error(`Sandbox input file disappeared during staging: ${record.id}`);
      const size = file.body.byteLength;
      if (size > this.limits.maxInputFileBytes) {
        throw new Error(`Sandbox input file exceeds byte limit: ${record.id}`);
      }
      transferredBytes += size;
      if (transferredBytes > this.limits.maxInputTotalBytes) {
        throw new Error(`Sandbox input total exceeds byte limit ${this.limits.maxInputTotalBytes}`);
      }

      const sandboxName = requireStoredName(record, usedNames);
      const internalPath = `/input/uploads/${sandboxName}`;
      const staged = await driver.stageInputFile(lease, {
        path: internalPath,
        content: Buffer.from(file.body).toString("base64"),
        encoding: "base64",
        contentType: file.contentType?.trim() || record.mime || "application/octet-stream",
      });
      if (staged.size !== size) throw new Error(`Sandbox staged input size mismatch: ${record.id}`);
      manifest.push({
        file_id: record.id,
        original_name: record.original_name,
        stored_name: record.stored_name,
        sandbox_path: `uploads/${sandboxName}`,
        size,
        mime: record.mime,
      });
    }

    const manifestBytes = Buffer.from(JSON.stringify({ files: manifest }, null, 2), "utf8");
    const stagedManifest = await driver.stageInputFile(lease, {
      path: "/input/uploads/.ragsystem-manifest.json",
      content: manifestBytes.toString("base64"),
      encoding: "base64",
      contentType: "application/json",
    });
    if (stagedManifest.size !== manifestBytes.byteLength) throw new Error("Sandbox input manifest size mismatch");
  }

  async collectOutputs(lease: SandboxLease, owner: SandboxOwner, driver: SandboxDriver): Promise<void> {
    const listed = await driver.glob(lease, {
      root: "/work",
      pattern: "**/*",
      recursive: true,
      maxResults: this.limits.maxOutputFiles + 1,
    });
    const outputFiles = listed.files.filter((file) => !isTransientWorkspacePath(file));
    if (listed.truncated || outputFiles.length > this.limits.maxOutputFiles) {
      throw new Error(`Sandbox output file count exceeds limit ${this.limits.maxOutputFiles}`);
    }

    const seen = new Set<string>();
    let totalBytes = 0;
    for (const rawPath of outputFiles) {
      const relativePath = validateDriverRelativePath(rawPath);
      if (seen.has(relativePath)) throw new Error(`Sandbox driver returned duplicate output path: ${relativePath}`);
      seen.add(relativePath);
      const result = await driver.readFile(lease, {
        path: `/work/${relativePath}`,
        encoding: "base64",
        maxBytes: this.limits.maxOutputFileBytes,
      });
      const body = decodeBase64(result.content);
      if (result.size !== body.byteLength) throw new Error(`Sandbox output size mismatch: ${relativePath}`);
      totalBytes += body.byteLength;
      if (totalBytes > this.limits.maxOutputTotalBytes) {
        throw new Error(`Sandbox output total exceeds byte limit ${this.limits.maxOutputTotalBytes}`);
      }
      await this.files.add(owner.sessionId, {
        originalName: relativePath,
        buffer: body,
        mime: inferMimeType(relativePath),
      });
    }
  }
}

function isTransientWorkspacePath(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized === "transient" || normalized.startsWith("transient/");
}

function validateInputMetadata(
  records: UploadedFileRecord[],
  owner: SandboxOwner,
  limits: SandboxFileTransferLimits,
): void {
  let total = 0;
  for (const record of records) {
    if (record.scope_type !== "session" || (record.scope_id !== null && record.scope_id !== owner.sessionId)) {
      throw new Error(`Sandbox input file is outside the current session: ${record.id}`);
    }
    if (!Number.isSafeInteger(record.size) || record.size < 0) throw new Error(`Sandbox input file has invalid size: ${record.id}`);
    if (record.size > limits.maxInputFileBytes) throw new Error(`Sandbox input file exceeds byte limit: ${record.id}`);
    total += record.size;
    if (total > limits.maxInputTotalBytes) throw new Error(`Sandbox input total exceeds byte limit ${limits.maxInputTotalBytes}`);
  }
}

function requireStoredName(record: UploadedFileRecord, usedNames: Set<string>): string {
  const storedName = record.stored_name.trim();
  if (!storedName || storedName === "." || storedName === ".." || storedName === ".ragsystem-manifest.json") {
    throw new Error(`Sandbox input file has an invalid stored_name: ${record.id}`);
  }
  if (storedName.includes("/") || storedName.includes("\\") || !/^[a-zA-Z0-9._-]+$/.test(storedName)) {
    throw new Error(`Sandbox input file stored_name is not portable: ${record.id}`);
  }
  const key = storedName.toLowerCase();
  if (usedNames.has(key)) throw new Error(`Sandbox input file stored_name is duplicated: ${storedName}`);
  usedNames.add(key);
  return storedName;
}

function validateDriverRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:($|\/)/.test(normalized) || normalized.includes("\0")) {
    throw new Error("Sandbox driver returned an invalid output path");
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) {
    throw new Error("Sandbox driver returned an unsafe output path");
  }
  return parts.join("/");
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.trim();
  if (normalized && (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1)) {
    throw new Error("Sandbox driver returned invalid base64 output");
  }
  const body = Buffer.from(normalized, "base64");
  if (body.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error("Sandbox driver returned invalid base64 output");
  }
  return body;
}

function inferMimeType(filePath: string): string {
  switch (path.posix.extname(filePath).toLowerCase()) {
    case ".txt": case ".md": case ".log": return "text/plain";
    case ".json": return "application/json";
    case ".csv": return "text/csv";
    case ".html": return "text/html";
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function validateLimits(limits: SandboxFileTransferLimits): SandboxFileTransferLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid sandbox file transfer limit: ${name}`);
  }
  return limits;
}
