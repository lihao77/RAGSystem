import fs from "node:fs";
import path from "node:path";
import { isAbsolutePathLike, isPathUnder, resolvePathLike } from "@ragsystem/backend-core/tools/shared/paths.js";

export class TenantPaths {
  readonly dataRoot: string;

  constructor(dataRoot: string) {
    if (!dataRoot.trim()) {
      throw new Error("tenant dataRoot 不能为空");
    }
    if (!isAbsolutePathLike(dataRoot)) {
      throw new Error(`tenant dataRoot 必须是绝对路径: ${dataRoot}`);
    }
    this.dataRoot = resolvePathLike(dataRoot);
  }

  systemRoot(): string { return path.join(this.dataRoot, "system"); }
  ragsystemDbPath(): string { return path.join(this.dataRoot, "db", "ragsystem.db"); }
  sessionRoot(sessionId: string): string { return path.join(this.dataRoot, "sessions", sessionId); }
  sessionWorkspace(sessionId: string): string { return path.join(this.sessionRoot(sessionId), "workspace"); }
  sessionUploads(sessionId: string): string { return path.join(this.sessionRoot(sessionId), "uploads"); }
  sessionSandbox(sessionId: string): string { return path.join(this.sessionRoot(sessionId), "sandbox"); }
  fileHistorySession(sessionId: string): string { return path.join(this.dataRoot, "file-history", sessionId); }
  configApp(): string { return path.join(this.dataRoot, "config", "app", "config.yaml"); }
  configMcp(): string { return path.join(this.dataRoot, "config", "mcp", "mcp_servers.yaml"); }
  configModelAdapter(): string { return path.join(this.dataRoot, "config", "model_adapter", "providers.yaml"); }
  configAgents(): string { return path.join(this.dataRoot, "config", "agents"); }

  safeJoin(...segments: string[]): string {
    for (const segment of segments) {
      if (isAbsolutePathLike(segment)) {
        throw new Error(`拒绝绝对路径注入: ${segment}`);
      }
    }
    return this.resolveWithin(path.join(this.dataRoot, ...segments));
  }

  resolveWithin(candidate: string): string {
    const resolvedCandidate = resolvePathLike(candidate);
    if (!isPathUnder(resolvedCandidate, this.dataRoot)) {
      throw new Error(`路径越出租户根目录: ${candidate}`);
    }

    const projectedRoot = projectRealPath(this.dataRoot);
    const projectedCandidate = projectRealPath(resolvedCandidate);
    if (!isPathUnder(projectedCandidate, projectedRoot)) {
      throw new Error(`路径通过符号链接越出租户根目录: ${candidate}`);
    }

    if (fs.existsSync(resolvedCandidate)) {
      const realCandidate = fs.realpathSync(resolvedCandidate);
      if (!isPathUnder(realCandidate, projectedRoot)) {
        throw new Error(`路径通过符号链接越出租户根目录: ${candidate}`);
      }
      return realCandidate;
    }
    return resolvedCandidate;
  }
}

function projectRealPath(value: string): string {
  let current = value;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return value;
    }
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), path.relative(current, value));
}
