import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TenantPaths } from "../../../src/services/runtime/tenant-paths.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("TenantPaths", () => {
  it("生成统一 tenant 子路径", () => {
    const root = makeTempRoot("tenant-paths-layout-");
    const paths = new TenantPaths(root);
    expect(paths.systemRoot()).toBe(path.join(root, "system"));
    expect(paths.ragsystemDbPath()).toBe(path.join(root, "db", "ragsystem.db"));
    expect(paths.knowledgeDbPath()).toBe(path.join(root, "db", "knowledge.db"));
    expect(paths.knowledgeUploadsRoot()).toBe(path.join(root, "db", "knowledge-uploads"));
    expect(paths.knowledgeMarkdownRoot()).toBe(path.join(root, "db", "knowledge-md"));
    expect(paths.sessionRoot("sid")).toBe(path.join(root, "sessions", "sid"));
    expect(paths.sessionTransient("sid")).toBe(path.join(root, "sessions", "sid", "transient"));
    expect(paths.sessionExports("sid", "run")).toBe(path.join(root, "sessions", "sid", "exports", "run"));
    expect(paths.sessionWorkspace("sid")).toBe(path.join(root, "sessions", "sid", "workspace"));
    expect(paths.sessionUploads("sid")).toBe(path.join(root, "sessions", "sid", "uploads"));
    expect(paths.sessionSandbox("sid")).toBe(path.join(root, "sessions", "sid", "sandbox"));
    expect(paths.sessionVisualizations("sid")).toBe(path.join(root, "sessions", "sid", "visualizations"));
    expect(paths.memoryRoot()).toBe(path.join(root, "memory"));
    expect(paths.memorySession("sid")).toBe(path.join(root, "memory", "sessions", "sid"));
    expect(paths.tasksSession("sid")).toBe(path.join(root, "tasks", "sid"));
    expect(paths.fileHistorySession("sid")).toBe(path.join(root, "file-history", "sid"));
    expect(paths.configApp()).toBe(path.join(root, "config", "app", "config.yaml"));
    expect(paths.configDaemon()).toBe(path.join(root, "config", "daemon", "daemon.yaml"));
    expect(paths.configMcp()).toBe(path.join(root, "config", "mcp", "mcp_servers.yaml"));
    expect(paths.configModelAdapter()).toBe(path.join(root, "config", "model_adapter", "providers.yaml"));
    expect(paths.configAgents()).toBe(path.join(root, "config", "agents"));
  });

  it("允许目标不存在但已存在祖先仍在 tenant 内", () => {
    const root = makeTempRoot("tenant-paths-missing-");
    fs.mkdirSync(path.join(root, "sessions"));
    const paths = new TenantPaths(root);
    expect(paths.safeJoin("sessions", "sid", "workspace", "new.txt"))
      .toBe(path.join(root, "sessions", "sid", "workspace", "new.txt"));
  });

  it("允许 tenant 根目录本身尚未创建", () => {
    const parent = makeTempRoot("tenant-paths-parent-");
    const root = path.join(parent, "tnt_new");
    const paths = new TenantPaths(root);
    expect(paths.safeJoin("sessions", "sid")).toBe(path.join(root, "sessions", "sid"));
  });

  it("拒绝词法越界、绝对路径和 UNC 注入", () => {
    const root = makeTempRoot("tenant-paths-injection-");
    const paths = new TenantPaths(root);
    expect(() => paths.safeJoin("..", "outside.txt")).toThrow("路径越出");
    expect(() => paths.safeJoin(path.resolve(root, "absolute.txt"))).toThrow("绝对路径注入");
    expect(() => paths.safeJoin(String.raw`\\server\share\file.txt`)).toThrow("绝对路径注入");
    expect(() => paths.safeJoin(String.raw`C:\outside\file.txt`)).toThrow("绝对路径注入");
  });

  it("拒绝 symlink 或 Junction 指向 tenant 外部", () => {
    const root = makeTempRoot("tenant-paths-root-");
    const outside = makeTempRoot("tenant-paths-outside-");
    const link = path.join(root, "escape");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(outside, link, linkType);
    const paths = new TenantPaths(root);
    expect(() => paths.resolveWithin(path.join(link, "new.txt"))).toThrow("符号链接越出");
  });
});

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
