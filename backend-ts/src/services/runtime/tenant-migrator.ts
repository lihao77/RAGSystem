import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LOCAL_TENANT_ID } from "../identity/index.js";
import { TenantPaths } from "./tenant-paths.js";

const MIGRATION_VERSION = 1;
const BACKUP_MARKER_NAME = ".tenant-migration-backup.json";
const DONE_MARKER_NAME = ".tenant-migration-done.json";
const LEGACY_BUSINESS_DIRECTORIES = ["db", "sessions", "config", "memory", "tasks", "file-history"] as const;

type LegacyBusinessDirectory = typeof LEGACY_BUSINESS_DIRECTORIES[number];

interface DirectorySummary {
  name: LegacyBusinessDirectory;
  entryCount: number;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  digest: string;
}

interface MigrationBackupMarker {
  version: number;
  state: "in_progress";
  startedAt: string;
  sourceRoot: string;
  targetRoot: string;
  directories: DirectorySummary[];
}

interface MigrationDoneMarker {
  version: number;
  state: "completed";
  startedAt: string;
  completedAt: string;
  sourceRoot: string;
  targetRoot: string;
  directories: DirectorySummary[];
}

export interface MigrationFileSystem {
  rename(source: string, target: string): void;
  copyDirectory(source: string, target: string): void;
  removeDirectory(target: string): void;
}

export interface TenantMigrationResult {
  status: "skipped" | "migrated";
  reason?: "already_completed" | "no_legacy_data";
  directories: string[];
}

export interface TenantMigratorOptions {
  dataRoot: string;
  tenantsRoot: string;
  systemRoot: string;
  fileSystem?: MigrationFileSystem;
}

export class TenantMigrator {
  private readonly dataRoot: string;
  private readonly systemRoot: string;
  private readonly tenantPaths: TenantPaths;
  private readonly fileSystem: MigrationFileSystem;

  constructor(options: TenantMigratorOptions) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.systemRoot = path.resolve(options.systemRoot);
    this.tenantPaths = new TenantPaths(path.join(path.resolve(options.tenantsRoot), LOCAL_TENANT_ID));
    this.fileSystem = options.fileSystem ?? defaultMigrationFileSystem;
  }

  migrate(): TenantMigrationResult {
    fs.mkdirSync(this.systemRoot, { recursive: true });
    const doneMarkerPath = path.join(this.systemRoot, DONE_MARKER_NAME);
    if (fs.existsSync(doneMarkerPath)) {
      return { status: "skipped", reason: "already_completed", directories: [] };
    }

    const backupMarkerPath = path.join(this.systemRoot, BACKUP_MARKER_NAME);
    const backup = fs.existsSync(backupMarkerPath)
      ? this.readBackupMarker(backupMarkerPath)
      : this.createBackupMarker();
    if (!backup) {
      return { status: "skipped", reason: "no_legacy_data", directories: [] };
    }
    if (!fs.existsSync(backupMarkerPath)) {
      writeJsonAtomically(backupMarkerPath, backup);
    }

    try {
      fs.mkdirSync(this.tenantPaths.dataRoot, { recursive: true });
      for (const summary of backup.directories) {
        const source = path.join(this.dataRoot, summary.name);
        const target = this.tenantPaths.safeJoin(summary.name);
        const sourceExists = fs.existsSync(source);
        const targetExists = fs.existsSync(target);
        if (sourceExists && targetExists) {
          throw new Error(`迁移目录源和目标同时存在，拒绝覆盖: ${summary.name}`);
        }
        if (sourceExists) {
          this.moveDirectory(source, target, summary);
        } else if (!targetExists) {
          throw new Error(`迁移目录源和目标均不存在: ${summary.name}`);
        }
        assertDirectorySummary(target, summary);
      }
      this.validateDatabases();
      const doneMarker: MigrationDoneMarker = {
        version: MIGRATION_VERSION,
        state: "completed",
        startedAt: backup.startedAt,
        completedAt: new Date().toISOString(),
        sourceRoot: backup.sourceRoot,
        targetRoot: backup.targetRoot,
        directories: backup.directories,
      };
      writeJsonAtomically(doneMarkerPath, doneMarker);
      fs.rmSync(backupMarkerPath, { force: true });
      return { status: "migrated", directories: backup.directories.map((item) => item.name) };
    } catch (error) {
      const rollbackError = this.rollback(backup.directories);
      if (rollbackError) {
        throw new AggregateError([error, rollbackError], "tenant 存量迁移失败，且回滚未完整完成");
      }
      fs.rmSync(backupMarkerPath, { force: true });
      removeDirectoryIfEmpty(this.tenantPaths.dataRoot);
      throw error;
    }
  }

  private createBackupMarker(): MigrationBackupMarker | null {
    const directories = LEGACY_BUSINESS_DIRECTORIES
      .filter((name) => fs.existsSync(path.join(this.dataRoot, name)))
      .map((name) => summarizeDirectory(path.join(this.dataRoot, name), name));
    if (directories.length === 0) return null;
    return {
      version: MIGRATION_VERSION,
      state: "in_progress",
      startedAt: new Date().toISOString(),
      sourceRoot: this.dataRoot,
      targetRoot: this.tenantPaths.dataRoot,
      directories,
    };
  }

  private readBackupMarker(markerPath: string): MigrationBackupMarker {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<MigrationBackupMarker>;
    if (marker.version !== MIGRATION_VERSION || marker.state !== "in_progress") {
      throw new Error(`不支持的 tenant 迁移备份标记: ${markerPath}`);
    }
    if (path.resolve(String(marker.sourceRoot)) !== this.dataRoot
      || path.resolve(String(marker.targetRoot)) !== this.tenantPaths.dataRoot
      || !Array.isArray(marker.directories)) {
      throw new Error(`tenant 迁移备份标记与当前路径不一致: ${markerPath}`);
    }
    const allowedNames = new Set<string>(LEGACY_BUSINESS_DIRECTORIES);
    const seenNames = new Set<string>();
    for (const summary of marker.directories) {
      if (!isDirectorySummary(summary) || !allowedNames.has(summary.name) || seenNames.has(summary.name)) {
        throw new Error(`tenant 迁移备份标记目录摘要无效: ${markerPath}`);
      }
      seenNames.add(summary.name);
    }
    return marker as MigrationBackupMarker;
  }

  private moveDirectory(source: string, target: string, expected: DirectorySummary): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      this.fileSystem.rename(source, target);
    } catch (error) {
      if (!isCrossDeviceError(error)) throw error;
      this.fileSystem.copyDirectory(source, target);
      try {
        assertDirectorySummary(target, expected);
        this.fileSystem.removeDirectory(source);
      } catch (copyError) {
        if (fs.existsSync(target)) this.fileSystem.removeDirectory(target);
        throw copyError;
      }
    }
  }

  private validateDatabases(): void {
    for (const name of ["ragsystem.db", "knowledge.db"] as const) {
      const dbPath = this.tenantPaths.safeJoin("db", name);
      if (!fs.existsSync(dbPath)) continue;
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare("PRAGMA quick_check").all() as unknown as Array<{ quick_check?: string }>;
        if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
          throw new Error(`${name} 完整性检查失败`);
        }
      } finally {
        db.close();
      }
    }
  }

  private rollback(directories: DirectorySummary[]): Error | null {
    const rollbackErrors: unknown[] = [];
    for (const summary of [...directories].reverse()) {
      const source = path.join(this.dataRoot, summary.name);
      const target = this.tenantPaths.safeJoin(summary.name);
      if (!fs.existsSync(target) || fs.existsSync(source)) continue;
      try {
        this.moveDirectory(target, source, summary);
        assertDirectorySummary(source, summary);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    return rollbackErrors.length > 0 ? new AggregateError(rollbackErrors, "tenant 存量迁移回滚失败") : null;
  }
}

export function createTenantMigrator(options: TenantMigratorOptions): TenantMigrator {
  return new TenantMigrator(options);
}

const defaultMigrationFileSystem: MigrationFileSystem = {
  rename(source, target) {
    fs.renameSync(source, target);
  },
  copyDirectory(source, target) {
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  },
  removeDirectory(target) {
    fs.rmSync(target, { recursive: true, force: true });
  },
};

function summarizeDirectory(directoryPath: string, name: LegacyBusinessDirectory): DirectorySummary {
  const entries: string[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  const visit = (currentPath: string, relativeRoot: string): void => {
    const children = fs.readdirSync(currentPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = path.join(currentPath, child.name);
      const relativePath = path.posix.join(relativeRoot.split(path.sep).join(path.posix.sep), child.name);
      if (child.isDirectory()) {
        directoryCount += 1;
        entries.push(`d:${relativePath}`);
        visit(childPath, relativePath);
      } else if (child.isFile()) {
        const size = fs.statSync(childPath).size;
        fileCount += 1;
        totalBytes += size;
        entries.push(`f:${relativePath}:${size}`);
      } else {
        throw new Error(`迁移目录包含不支持的条目类型: ${childPath}`);
      }
    }
  };
  visit(directoryPath, "");
  return {
    name,
    entryCount: fileCount + directoryCount,
    fileCount,
    directoryCount,
    totalBytes,
    digest: createHash("sha256").update(entries.join("\n")).digest("hex"),
  };
}

function assertDirectorySummary(target: string, expected: DirectorySummary): void {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`迁移目标目录不存在: ${target}`);
  }
  const actual = summarizeDirectory(target, expected.name);
  if (actual.entryCount !== expected.entryCount
    || actual.fileCount !== expected.fileCount
    || actual.directoryCount !== expected.directoryCount
    || actual.totalBytes !== expected.totalBytes
    || actual.digest !== expected.digest) {
    throw new Error(`迁移目标目录校验失败: ${expected.name}`);
  }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function removeDirectoryIfEmpty(directoryPath: string): void {
  if (!fs.existsSync(directoryPath)) return;
  if (fs.readdirSync(directoryPath).length === 0) fs.rmdirSync(directoryPath);
  const parent = path.dirname(directoryPath);
  if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
}

function isCrossDeviceError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EXDEV";
}

function isDirectorySummary(value: unknown): value is DirectorySummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Partial<DirectorySummary>;
  return typeof summary.name === "string"
    && Number.isSafeInteger(summary.entryCount) && Number(summary.entryCount) >= 0
    && Number.isSafeInteger(summary.fileCount) && Number(summary.fileCount) >= 0
    && Number.isSafeInteger(summary.directoryCount) && Number(summary.directoryCount) >= 0
    && Number.isSafeInteger(summary.totalBytes) && Number(summary.totalBytes) >= 0
    && typeof summary.digest === "string" && /^[a-f0-9]{64}$/.test(summary.digest);
}
