import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { TenantMigrator, type MigrationFileSystem } from "../../../src/services/runtime/tenant-migrator.js";
import { makeTempRoot } from "../../helpers/temp-db.js";

const BUSINESS_DIRECTORIES = ["db", "sessions", "config", "memory", "tasks", "file-history"] as const;

describe("TenantMigrator", () => {
  it("全新安装无旧业务目录时不迁移", () => {
    const harness = createHarness();
    fs.mkdirSync(harness.systemRoot, { recursive: true });
    fs.writeFileSync(path.join(harness.systemRoot, "control.db"), "control");
    expect(harness.migrator.migrate()).toEqual({ status: "skipped", reason: "no_legacy_data", directories: [] });
    expect(fs.existsSync(harness.targetRoot)).toBe(false);
    expect(fs.readFileSync(path.join(harness.systemRoot, "control.db"), "utf8")).toBe("control");
  });

  it("完整迁移旧布局并保留目录结构和标记摘要", () => {
    const harness = createHarness();
    createLegacyLayout(harness.dataRoot);
    fs.mkdirSync(harness.systemRoot, { recursive: true });
    fs.writeFileSync(path.join(harness.systemRoot, "control.db"), "control");
    expect(harness.migrator.migrate()).toEqual({ status: "migrated", directories: [...BUSINESS_DIRECTORIES] });
    for (const directory of BUSINESS_DIRECTORIES) {
      expect(fs.existsSync(path.join(harness.dataRoot, directory))).toBe(false);
      expect(fs.existsSync(path.join(harness.targetRoot, directory))).toBe(true);
    }
    expect(fs.readFileSync(path.join(harness.targetRoot, "sessions", "sid", "workspace", "note.txt"), "utf8"))
      .toBe("session-data");
    expect(fs.existsSync(path.join(harness.dataRoot, "system"))).toBe(true);
    expect(fs.existsSync(path.join(harness.dataRoot, "tenants"))).toBe(true);
    expect(fs.readFileSync(path.join(harness.systemRoot, "control.db"), "utf8")).toBe("control");
    expect(fs.existsSync(path.join(harness.systemRoot, ".tenant-migration-backup.json"))).toBe(false);
    const marker = readJson(path.join(harness.systemRoot, ".tenant-migration-done.json"));
    expect(marker).toMatchObject({ version: 1, state: "completed", sourceRoot: harness.dataRoot, targetRoot: harness.targetRoot });
    expect(marker.directories).toHaveLength(BUSINESS_DIRECTORIES.length);
    expect(marker.directories[0]).toMatchObject({ name: "db", entryCount: 2, fileCount: 2, directoryCount: 0 });
    expect(marker.directories[0].digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("完成标记存在时二次运行幂等跳过", () => {
    const harness = createHarness();
    createLegacyLayout(harness.dataRoot);
    harness.migrator.migrate();
    fs.mkdirSync(path.join(harness.dataRoot, "sessions", "new-session"), { recursive: true });
    expect(harness.migrator.migrate()).toEqual({ status: "skipped", reason: "already_completed", directories: [] });
    expect(fs.existsSync(path.join(harness.dataRoot, "sessions", "new-session"))).toBe(true);
  });

  it("迁移后两个业务数据库可只读打开并通过 quick_check", () => {
    const harness = createHarness();
    createLegacyLayout(harness.dataRoot);
    harness.migrator.migrate();
    for (const dbName of ["ragsystem.db", "knowledge.db"]) {
      const db = new DatabaseSync(path.join(harness.targetRoot, "db", dbName), { readOnly: true });
      try {
        expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        expect(db.prepare("SELECT value FROM migration_fixture").get()).toEqual({ value: dbName });
      } finally {
        db.close();
      }
    }
  });

  it("目录移动失败时按备份清单完整回滚", () => {
    const harness = createHarness(createFailingFileSystem({ failMoveCall: 2 }));
    createLegacyLayout(harness.dataRoot);
    expect(() => harness.migrator.migrate()).toThrow("模拟目录移动失败");
    for (const directory of BUSINESS_DIRECTORIES) {
      expect(fs.existsSync(path.join(harness.dataRoot, directory))).toBe(true);
      expect(fs.existsSync(path.join(harness.targetRoot, directory))).toBe(false);
    }
    expect(fs.existsSync(path.join(harness.systemRoot, ".tenant-migration-backup.json"))).toBe(false);
    expect(fs.existsSync(path.join(harness.systemRoot, ".tenant-migration-done.json"))).toBe(false);
  });

  it("数据库完整性校验失败时回滚全部目录", () => {
    const harness = createHarness();
    createLegacyLayout(harness.dataRoot);
    fs.writeFileSync(path.join(harness.dataRoot, "db", "knowledge.db"), "not-a-sqlite-database");
    expect(() => harness.migrator.migrate()).toThrow();
    for (const directory of BUSINESS_DIRECTORIES) {
      expect(fs.existsSync(path.join(harness.dataRoot, directory))).toBe(true);
      expect(fs.existsSync(path.join(harness.targetRoot, directory))).toBe(false);
    }
    expect(fs.existsSync(path.join(harness.systemRoot, ".tenant-migration-backup.json"))).toBe(false);
    expect(fs.existsSync(path.join(harness.systemRoot, ".tenant-migration-done.json"))).toBe(false);
  });

  it("部分中断遗留备份标记时继续迁移", () => {
    const interrupted = createHarness(createFailingFileSystem({ failMoveCall: 2, failRollback: true }));
    createLegacyLayout(interrupted.dataRoot);
    expect(() => interrupted.migrator.migrate()).toThrow("回滚未完整完成");
    expect(fs.existsSync(path.join(interrupted.targetRoot, "db"))).toBe(true);
    expect(fs.existsSync(path.join(interrupted.dataRoot, "db"))).toBe(false);
    expect(fs.existsSync(path.join(interrupted.dataRoot, "sessions"))).toBe(true);
    expect(fs.existsSync(path.join(interrupted.systemRoot, ".tenant-migration-backup.json"))).toBe(true);
    const resumed = new TenantMigrator({ dataRoot: interrupted.dataRoot, tenantsRoot: interrupted.tenantsRoot, systemRoot: interrupted.systemRoot });
    expect(resumed.migrate()).toEqual({ status: "migrated", directories: [...BUSINESS_DIRECTORIES] });
    for (const directory of BUSINESS_DIRECTORIES) {
      expect(fs.existsSync(path.join(interrupted.dataRoot, directory))).toBe(false);
      expect(fs.existsSync(path.join(interrupted.targetRoot, directory))).toBe(true);
    }
    expect(fs.existsSync(path.join(interrupted.systemRoot, ".tenant-migration-backup.json"))).toBe(false);
    expect(fs.existsSync(path.join(interrupted.systemRoot, ".tenant-migration-done.json"))).toBe(true);
  });
});

function createHarness(fileSystem?: MigrationFileSystem) {
  const dataRoot = makeTempRoot();
  const tenantsRoot = path.join(dataRoot, "tenants");
  const systemRoot = path.join(dataRoot, "system");
  const targetRoot = path.join(tenantsRoot, "tnt_local");
  const migrator = new TenantMigrator({ dataRoot, tenantsRoot, systemRoot, ...(fileSystem ? { fileSystem } : {}) });
  return { dataRoot, tenantsRoot, systemRoot, targetRoot, migrator };
}

function createLegacyLayout(dataRoot: string): void {
  const dbRoot = path.join(dataRoot, "db");
  fs.mkdirSync(dbRoot, { recursive: true });
  createSqliteFixture(path.join(dbRoot, "ragsystem.db"), "ragsystem.db");
  createSqliteFixture(path.join(dbRoot, "knowledge.db"), "knowledge.db");
  writeFixture(dataRoot, "sessions", "sid", "workspace", "note.txt", "session-data");
  writeFixture(dataRoot, "config", "app", "config.yaml", "theme: dark\n");
  writeFixture(dataRoot, "memory", "sessions", "sid", "MEMORY.md", "memory-data");
  writeFixture(dataRoot, "tasks", "sid", "tasks.json", "[]\n");
  writeFixture(dataRoot, "file-history", "sid", "history.json", "{}\n");
}

function createSqliteFixture(dbPath: string, value: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE migration_fixture(value TEXT NOT NULL)");
    db.prepare("INSERT INTO migration_fixture(value) VALUES (?)").run(value);
  } finally {
    db.close();
  }
}

function writeFixture(dataRoot: string, ...parts: string[]): void {
  const content = parts.pop();
  if (content === undefined) throw new Error("fixture 内容缺失");
  const filePath = path.join(dataRoot, ...parts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createFailingFileSystem(options: { failMoveCall: number; failRollback?: boolean }): MigrationFileSystem {
  let callCount = 0;
  return {
    rename(source, target) {
      callCount += 1;
      const rollback = source.includes(path.join("tenants", "tnt_local"));
      if (callCount === options.failMoveCall || (rollback && options.failRollback)) {
        throw new Error(rollback ? "模拟进程中断导致回滚失败" : "模拟目录移动失败");
      }
      fs.renameSync(source, target);
    },
    copyDirectory(source, target) {
      fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
    },
    removeDirectory(target) {
      fs.rmSync(target, { recursive: true, force: true });
    },
  };
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
