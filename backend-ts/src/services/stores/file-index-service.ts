import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

import type { UploadedFileRecord } from "../../contracts/files.js";
import {
  AddFileInputSchema,
  ListFilesInputSchema,
  type AddFileInput,
  type FileIndexStoreOptions,
  type FileScopeType,
  type IFileIndexStore,
  type ListFilesInput,
} from "../../contracts/file-index-store/index.js";

type SqlInputValue = string | number | bigint | Uint8Array | null;

interface UploadedFileRow {
  id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  size: number;
  mime: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
  indexed_in_vector: number;
  tags: string | null;
  notes: string | null;
  scope_type: "global" | "session";
  scope_id: string | null;
}

export class FileIndexService implements IFileIndexStore {
  private readonly db: import("node:sqlite").DatabaseSync;
  private readonly dataRoot: string;

  constructor(options: FileIndexStoreOptions) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
    if (options.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initDatabase();
  }

  close(): void {
    this.db.close();
  }

  getGlobalUploadsRoot(): string {
    return path.join(this.dataRoot, "uploads");
  }

  getSessionUploadsRoot(sessionId: string): string {
    return path.join(this.dataRoot, "sessions", sessionId, "uploads");
  }

  list(input: ListFilesInput): UploadedFileRecord[] {
    const parsed = ListFilesInputSchema.parse(input);
    const rows = this.db
      .prepare(
        `
          SELECT * FROM uploaded_files
          WHERE scope_type = ? AND ${parsed.scopeId == null ? "scope_id IS NULL" : "scope_id = ?"}
          ORDER BY uploaded_at DESC
        `,
      )
      .all(...scopeParams(parsed.scopeType, parsed.scopeId)) as unknown as UploadedFileRow[];
    return rows.map(rowToFileRecord).filter((record) => matchesFilters(record, parsed.extensions, parsed.mimeTypes));
  }

  get(fileId: string, scopeType: FileScopeType, scopeId?: string | null): UploadedFileRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT * FROM uploaded_files
          WHERE id = ? AND scope_type = ? AND ${scopeId == null ? "scope_id IS NULL" : "scope_id = ?"}
        `,
      )
      .get(fileId, ...scopeParams(scopeType, scopeId)) as UploadedFileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  add(input: AddFileInput): UploadedFileRecord {
    const parsed = AddFileInputSchema.parse(input);
    const { originalName, buffer, mime, scopeType, scopeId } = parsed;
    // 深合约前置条件：session scope 必须提供 scopeId，否则物理路径退化污染（sessions//uploads）
    let uploadRoot: string;
    if (scopeType === "session") {
      if (!scopeId) {
        throw new Error("session scope requires scopeId");
      }
      uploadRoot = this.getSessionUploadsRoot(scopeId);
    } else {
      uploadRoot = this.getGlobalUploadsRoot();
    }
    const storedName = `${randomBytes(8).toString("hex")}_${sanitizeFilename(originalName)}`;
    const storedPath = path.join(uploadRoot, storedName);
    const size = buffer.byteLength;
    // 物理 blob 落盘
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.writeFileSync(storedPath, buffer);
    const fileId = this.nextFileId();
    const now = new Date().toISOString();
    // INSERT 元数据；失败回滚物理文件，不留孤儿 blob（收编：blob 写入与元数据登记同进 store）
    try {
      this.db
        .prepare(
          `
            INSERT INTO uploaded_files
            (id, original_name, stored_name, stored_path, size, mime,
             uploaded_at, uploaded_by, indexed_in_vector, tags, notes, scope_type, scope_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          fileId,
          originalName,
          storedName,
          storedPath,
          size,
          mime,
          now,
          null,
          0,
          null,
          null,
          scopeType,
          scopeId ?? null,
        );
    } catch (err) {
      fs.rmSync(storedPath, { force: true });
      throw err;
    }
    const record = this.get(fileId, scopeType, scopeId ?? null);
    if (!record) {
      // 回滚彻底：删物理文件 + DB 行（INSERT 成功却读不回的防御，避免孤儿行）
      fs.rmSync(storedPath, { force: true });
      this.db.prepare("DELETE FROM uploaded_files WHERE id = ?").run(fileId);
      throw new Error(`failed to read created file record: ${fileId}`);
    }
    return record;
  }

  delete(fileId: string, scopeType: FileScopeType, scopeId?: string | null): UploadedFileRecord | null {
    const record = this.get(fileId, scopeType, scopeId ?? null);
    if (!record) {
      return null;
    }
    this.db.prepare("DELETE FROM uploaded_files WHERE id = ?").run(fileId);
    return record;
  }

  private nextFileId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const fileId = randomBytes(5).toString("hex");
      const row = this.db.prepare("SELECT id FROM uploaded_files WHERE id = ?").get(fileId) as
        | { id: string }
        | undefined;
      if (!row) {
        return fileId;
      }
    }
    return randomBytes(8).toString("hex");
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS uploaded_files (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime TEXT,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        uploaded_by TEXT,
        indexed_in_vector BOOLEAN DEFAULT FALSE,
        tags TEXT,
        notes TEXT,
        scope_type TEXT NOT NULL DEFAULT 'global',
        scope_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_uploaded_files_uploaded_at ON uploaded_files(uploaded_at);
      CREATE INDEX IF NOT EXISTS idx_uploaded_files_mime ON uploaded_files(mime);
      CREATE INDEX IF NOT EXISTS idx_uploaded_files_scope ON uploaded_files(scope_type, scope_id);
    `);
  }
}

function sanitizeFilename(filename: string): string {
  const normalized = filename.replace(/[^\w\-.]/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "upload.bin";
}

function scopeParams(scopeType: FileScopeType, scopeId?: string | null): SqlInputValue[] {
  return scopeId == null ? [scopeType] : [scopeType, scopeId];
}

function rowToFileRecord(row: UploadedFileRow): UploadedFileRecord {
  return {
    id: row.id,
    original_name: row.original_name,
    stored_name: row.stored_name,
    stored_path: row.stored_path,
    size: row.size,
    mime: row.mime ?? "",
    uploaded_at: row.uploaded_at,
    uploaded_by: row.uploaded_by,
    indexed_in_vector: Boolean(row.indexed_in_vector),
    tags: row.tags,
    notes: row.notes,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
  };
}

function matchesFilters(record: UploadedFileRecord, extensions?: string[], mimeTypes?: string[]): boolean {
  const extList = normalizeList(extensions);
  const mimeList = normalizeList(mimeTypes);
  const matchesExt = extList.some((extension) => record.original_name.toLowerCase().endsWith(extension));
  const matchesMime = mimeList.some((mime) => record.mime.toLowerCase() === mime);

  if (extList.length && mimeList.length) {
    return matchesExt || matchesMime;
  }
  if (extList.length) {
    return matchesExt;
  }
  if (mimeList.length) {
    return matchesMime;
  }
  return true;
}

function normalizeList(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
