import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type {
  WorkspaceFileApplication,
  WorkspaceFileEntry,
  WorkspaceFileListResult,
  WorkspaceFileReadResult,
} from "@ragsystem/backend-core/contracts/application/workspace-file-application.js";
import { inferMimeType } from "@ragsystem/backend-core/utils/mime.js";

/** 单目录条目上限：巨型目录（如 node_modules）截断展示，避免一次响应过载。 */
const MAX_DIRECTORY_ENTRIES = 500;

export class LocalWorkspaceFileApplication implements WorkspaceFileApplication {
  constructor(
    private readonly resolveWorkspaceRoot: (sessionId: string) => Promise<string | null>,
    private readonly resolveWorkspaceRootById: (workspaceId: string) => Promise<string | null> = async () => null,
  ) {}

  async read(sessionId: string, filePath: string): Promise<WorkspaceFileReadResult> {
    const root = await this.resolveWorkspaceRoot(sessionId);
    if (!root) return { status: "not_found" };
    return readFromRoot(root, filePath);
  }

  async listWorkspaceEntries(workspaceId: string, directoryPath: string): Promise<WorkspaceFileListResult> {
    const root = await this.resolveWorkspaceRootById(workspaceId);
    if (!root) return { status: "not_found", entries: [], truncated: false };
    const relativePath = normalizeWorkspacePath(directoryPath.trim() === "" ? "." : directoryPath);
    const resolved = path.resolve(root, relativePath);
    if (!isPathUnder(resolved, root)) return { status: "not_found", entries: [], truncated: false };
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(resolved, { withFileTypes: true });
    } catch (error) {
      if (isMissingError(error)) return { status: "not_found", entries: [], truncated: false };
      throw error;
    }
    // 只收真实目录与文件：dirent 反映条目本身类型，符号链接/管道等一律跳过，
    // 避免工作空间内指向外部的 symlink 把浏览范围带出项目根。
    const dirNames: string[] = [];
    const fileNames: string[] = [];
    for (const dirent of dirents) {
      if (dirent.isDirectory()) dirNames.push(dirent.name);
      else if (dirent.isFile()) fileNames.push(dirent.name);
    }
    const byName = (a: string, b: string) => a.localeCompare(b);
    dirNames.sort(byName);
    fileNames.sort(byName);
    const prefix = relativePath === "." ? "" : `${relativePath}/`;
    const entries: WorkspaceFileEntry[] = dirNames.map((name) => ({ name, path: `${prefix}${name}`, type: "directory" as const, size: null }));
    // readdir 不带 size；逐文件 stat。列举与 stat 之间文件可能被删，失败降级为无 size 而非整页失败。
    const fileEntries = await Promise.all(fileNames.map(async (name) => {
      const stats = await fs.stat(path.join(resolved, name)).catch(() => null);
      return { name, path: `${prefix}${name}`, type: "file" as const, size: stats?.isFile() ? stats.size : null };
    }));
    entries.push(...fileEntries);
    const truncated = entries.length > MAX_DIRECTORY_ENTRIES;
    return {
      status: "ok",
      entries: truncated ? entries.slice(0, MAX_DIRECTORY_ENTRIES) : entries,
      truncated,
    };
  }

  async readWorkspaceEntry(workspaceId: string, filePath: string): Promise<WorkspaceFileReadResult> {
    const root = await this.resolveWorkspaceRootById(workspaceId);
    if (!root) return { status: "not_found" };
    return readFromRoot(root, filePath);
  }
}

async function readFromRoot(root: string, filePath: string): Promise<WorkspaceFileReadResult> {
  const relativePath = normalizeWorkspacePath(filePath);
  const resolved = path.resolve(root, relativePath);
  if (!isPathUnder(resolved, root)) return { status: "not_found" };
  try {
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) return { status: "not_found" };
    return {
      status: "found",
      body: await fs.readFile(resolved),
      contentType: inferMimeType(resolved),
      size: stats.size,
      path: relativePath,
      // mtime+size 足以识别同路径改写；文件系统精度内同毫秒等长重写属可忽略的极端情形
      etag: `local-ws-${stats.mtimeMs}-${stats.size}`,
    };
  } catch (error) {
    if (isMissingError(error)) return { status: "not_found" };
    throw error;
  }
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  // ENOTDIR：路径中某段是文件，同属"这里没有这个目录"的确定性答案
  return code === "ENOENT" || code === "ENOTDIR";
}

function normalizeWorkspacePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  const withoutSpace = normalized.replace(/^workspace\//i, "");
  if (!withoutSpace || withoutSpace.startsWith("/") || /^[A-Za-z]:($|\/)/u.test(withoutSpace)) {
    throw new Error("workspace file path must be relative");
  }
  const canonical = path.posix.normalize(withoutSpace);
  if (canonical === ".." || canonical.startsWith("../") || canonical.includes("/../") || canonical.includes("\0")) {
    throw new Error("workspace file path escapes its workspace");
  }
  return canonical.replace(/^\.\//, "");
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
