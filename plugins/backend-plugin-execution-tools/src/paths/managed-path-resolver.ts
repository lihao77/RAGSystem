import { normalizeString } from "@ragsystem/backend-core/utils/guards.js";
import fs from "node:fs";
import path from "node:path";

import type { ToolExecContext } from "@ragsystem/agent-sdk";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { isAbsolutePathLike, isPathUnder, resolvePathLike } from "@ragsystem/backend-core/tools/shared/paths.js";

const DISPLAY_PATH_PREFIX = "./data/";

export type ManagedSpace = "workspace" | "transient" | "uploads" | "artifacts" | "exports" | "sandbox";

export interface ManagedRoots {
  workspace: string;
  transient: string;
  uploads: string;
  artifacts: string;
  exports: string;
  sandbox: string;
}

/**
 * The single path policy for local execution tools.
 *
 * It derives roots, resolves aliases, validates managed boundaries, and
 * delegates approval of external paths to the run-scoped PathAccessPolicy.
 */
export class ManagedPathResolver {
  private readonly dataRoot: string;

  constructor(dataRoot: string) {
    if (!dataRoot?.trim()) {
      throw new Error("ManagedPathResolver 必须传入已解析的 dataRoot");
    }
    this.dataRoot = path.resolve(dataRoot);
  }

  getDataRoot(): string {
    return this.dataRoot;
  }

  roots(context: ToolExecContext): ManagedRoots {
    const sessionId = normalizeString(context.sessionId) ?? "anonymous";
    const runId = normalizeString(context.runId);
    const sessionRoot = path.join(this.dataRoot, "sessions", sessionId);
    return {
      workspace: path.resolve(normalizeString(context.workspaceRoot) ?? path.join(sessionRoot, "workspace")),
      transient: path.join(sessionRoot, "transient"),
      uploads: path.join(sessionRoot, "uploads"),
      artifacts: path.join(sessionRoot, "artifacts"),
      exports: runId ? path.join(sessionRoot, "exports", runId) : path.join(sessionRoot, "exports"),
      sandbox: path.join(sessionRoot, "sandbox"),
    };
  }

  getExternalCandidates(
    workingDir: string | null | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string[] {
    const rawDir = normalizeString(workingDir);
    if (!rawDir || rawDir.startsWith(DISPLAY_PATH_PREFIX) || !isAbsolutePathLike(rawDir)) {
      return [];
    }
    const candidatePath = resolvePathLike(rawDir);
    if (pathService.isApproved(candidatePath)) {
      return [];
    }
    if (this.allowedRoots(context, "working_directory").some((root) => isPathUnder(candidatePath, root))) {
      return [];
    }
    return [candidatePath];
  }

  resolveWorkingDirectory(
    workingDir: string | null | undefined,
    workingDirSpace: string | null | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string {
    const rawDir = normalizeString(workingDir) ?? ".";
    const explicitSpace = normalizeManagedSpace(workingDirSpace);
    const displayMapped = this.fromDisplayPath(rawDir);
    const candidate = displayMapped
      ?? (isAbsolutePathLike(rawDir)
        ? resolvePathLike(rawDir)
        : this.resolveRelative(rawDir, explicitSpace, context));
    const resolved = this.assertAllowedPath(candidate, context, rawDir, pathService, "working_directory");
    if (!fs.existsSync(resolved)) {
      throw new Error(`工作目录不存在: ${workingDir ?? rawDir}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`路径不是目录: ${workingDir ?? rawDir}`);
    }
    return resolved;
  }

  resolveSearchRoot(rawPath: string | null | undefined, context: ToolExecContext): string {
    const raw = normalizeString(rawPath) ?? ".";
    const displayMapped = this.fromDisplayPath(raw);
    const candidate = displayMapped
      ?? (isAbsolutePathLike(raw)
        ? resolvePathLike(raw)
        : this.resolveRelative(raw, null, context));
    const resolved = this.assertAllowedPath(candidate, context, raw, null, "read");
    if (!fs.existsSync(resolved)) {
      throw new Error(`路径不存在: ${rawPath ?? this.roots(context).workspace}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`路径不是目录: ${rawPath ?? resolved}`);
    }
    return resolved;
  }

  toDisplayPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (isPathUnder(resolved, this.dataRoot)) {
      return `${DISPLAY_PATH_PREFIX}${path.relative(this.dataRoot, resolved).replaceAll(path.sep, "/")}`;
    }
    return resolved;
  }

  private resolveRelative(rawPath: string, explicitSpace: ManagedSpace | null, context: ToolExecContext): string {
    const roots = this.roots(context);
    // A bare managed-space name is an alias for that root. Prefixing it with
    // ./ intentionally bypasses this branch and addresses a real child dir.
    if (!explicitSpace && isManagedSpaceAlias(rawPath)) {
      this.assertSpaceContext(rawPath, context);
      fs.mkdirSync(roots[rawPath], { recursive: true });
      return roots[rawPath];
    }
    const space = explicitSpace ?? "workspace";
    this.assertSpaceContext(space, context);
    fs.mkdirSync(roots[space], { recursive: true });
    return path.resolve(roots[space], rawPath);
  }

  private assertSpaceContext(space: ManagedSpace, context: ToolExecContext): void {
    if (!normalizeString(context.sessionId) && space !== "workspace") {
      throw new Error(`${space} 工作目录缺少 session_id`);
    }
    if (space === "workspace" && !normalizeString(context.sessionId) && !normalizeString(context.workspaceRoot)) {
      throw new Error("bash 默认工作目录为 workspace，但当前缺少可用 workspace 上下文");
    }
    if (space === "exports" && !normalizeString(context.runId)) {
      throw new Error("exports 工作目录缺少 run_id");
    }
  }

  private allowedRoots(context: ToolExecContext, mode: "working_directory" | "read"): string[] {
    const roots = this.roots(context);
    if (mode === "working_directory") {
      return [roots.workspace, roots.transient, roots.exports];
    }
    return Object.values(roots);
  }

  private assertAllowedPath(
    candidatePath: string,
    context: ToolExecContext,
    originalPath: string,
    pathService: PathAccessPolicy | null,
    mode: "working_directory" | "read",
  ): string {
    const roots = this.allowedRoots(context, mode);
    if (pathService) {
      return pathService.assertWithin(candidatePath, roots, originalPath);
    }
    const resolved = path.resolve(candidatePath);
    if (!roots.some((root) => isPathUnder(resolved, root))) {
      throw new Error(`路径 '${originalPath}' 超出允许的受管目录范围，禁止访问`);
    }
    return resolved;
  }

  private fromDisplayPath(filePath: string): string | null {
    if (!filePath.startsWith(DISPLAY_PATH_PREFIX)) {
      return null;
    }
    return path.join(this.dataRoot, filePath.slice(DISPLAY_PATH_PREFIX.length));
  }
}

function normalizeManagedSpace(value: unknown): ManagedSpace | null {
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (isManagedSpaceAlias(normalized)) {
    return normalized;
  }
  throw new Error(`不支持的显式空间: ${value}`);
}

function isManagedSpaceAlias(value: string): value is ManagedSpace {
  return value === "workspace"
    || value === "transient"
    || value === "uploads"
    || value === "artifacts"
    || value === "exports"
    || value === "sandbox";
}
