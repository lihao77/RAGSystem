import fs from "node:fs/promises";
import path from "node:path";

import type { WorkspaceFileApplication, WorkspaceFileReadResult } from "@ragsystem/backend-core/contracts/application/workspace-file-application.js";
import { inferMimeType } from "@ragsystem/backend-core/utils/mime.js";

export class LocalWorkspaceFileApplication implements WorkspaceFileApplication {
  constructor(private readonly resolveWorkspaceRoot: (sessionId: string) => Promise<string | null>) {}

  async read(sessionId: string, filePath: string): Promise<WorkspaceFileReadResult> {
    const root = await this.resolveWorkspaceRoot(sessionId);
    if (!root) return { status: "not_found" };
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
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "not_found" };
      throw error;
    }
  }
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

