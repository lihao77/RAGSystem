import fs from "node:fs";
import path from "node:path";

import type { RuntimeToolExecutionContext } from "../../runtime/runtime-tool-types.js";

const DISPLAY_PATH_PREFIX = "./data/";

type ManagedSpace = "workspace" | "transient" | "exports";

export class BashPathResolver {
  constructor(private readonly dataRoot: string) {}

  getExternalPathApprovalCandidates(
    workingDir: string | null | undefined,
    context: RuntimeToolExecutionContext,
  ): string[] {
    const rawDir = normalizeString(workingDir);
    if (!rawDir || rawDir.startsWith(DISPLAY_PATH_PREFIX) || !isAbsolutePathLike(rawDir)) {
      return [];
    }
    const candidatePath = resolvePathLike(rawDir);
    try {
      this.assertAllowedPath(
        candidatePath,
        {
          ...context,
          approvedExternalPaths: [],
        },
        rawDir,
      );
      return [];
    } catch {
      return [candidatePath];
    }
  }

  resolveWorkingDirectory(
    workingDir: string | null,
    workingDirSpace: string | null,
    context: RuntimeToolExecutionContext,
  ): string {
    const rawDir = normalizeString(workingDir) ?? ".";
    const displayMapped = this.fromDisplayPath(rawDir);
    const candidate = displayMapped
      ? displayMapped
      : isAbsolutePathLike(rawDir)
        ? resolvePathLike(rawDir)
        : path.resolve(this.managedSpaceRoot(normalizeManagedSpace(workingDirSpace) ?? "workspace", context), rawDir);
    const resolved = this.assertAllowedPath(candidate, context, rawDir);
    if (!fs.existsSync(resolved)) {
      throw new Error(`工作目录不存在: ${workingDir ?? rawDir}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`路径不是目录: ${workingDir ?? rawDir}`);
    }
    return resolved;
  }

  toDisplayPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    const root = path.resolve(this.dataRoot);
    if (isPathUnder(resolved, root)) {
      return `${DISPLAY_PATH_PREFIX}${path.relative(root, resolved).replaceAll(path.sep, "/")}`;
    }
    return resolved;
  }

  private managedSpaceRoot(space: ManagedSpace, context: RuntimeToolExecutionContext): string {
    if (space === "workspace") {
      const root = this.effectiveWorkspaceRoot(context);
      if (!root) {
        throw new Error("bash 默认工作目录为 workspace，但当前缺少可用 workspace 上下文");
      }
      fs.mkdirSync(root, { recursive: true });
      return root;
    }
    const sessionId = normalizeString(context.sessionId);
    if (!sessionId) {
      throw new Error(`${space} 工作目录缺少 session_id`);
    }
    if (space === "transient") {
      const root = path.join(this.dataRoot, "sessions", sessionId, "transient");
      fs.mkdirSync(root, { recursive: true });
      return root;
    }
    const runId = normalizeString(context.runId);
    if (!runId) {
      throw new Error("exports 工作目录缺少 run_id");
    }
    const root = path.join(this.dataRoot, "sessions", sessionId, "exports", runId);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  private effectiveWorkspaceRoot(context: RuntimeToolExecutionContext): string | null {
    const workspaceRoot = normalizeString(context.workspaceRoot) ?? normalizeString(asRecord(context.agent?.custom_params)?.workspace_root);
    if (workspaceRoot) {
      return path.resolve(workspaceRoot);
    }
    const sessionId = normalizeString(context.sessionId);
    return sessionId ? path.join(this.dataRoot, "sessions", sessionId, "workspace") : null;
  }

  private allowedRoots(context: RuntimeToolExecutionContext): string[] {
    const sessionId = normalizeString(context.sessionId);
    const runId = normalizeString(context.runId);
    return dedupePaths([
      this.effectiveWorkspaceRoot(context),
      sessionId ? path.join(this.dataRoot, "sessions", sessionId, "transient") : null,
      sessionId && runId ? path.join(this.dataRoot, "sessions", sessionId, "exports", runId) : null,
      ...(context.approvedExternalPaths ?? []),
    ]);
  }

  private assertAllowedPath(candidatePath: string, context: RuntimeToolExecutionContext, originalPath: string): string {
    const resolved = path.resolve(candidatePath);
    const allowedRoots = this.allowedRoots(context);
    if (allowedRoots.some((root) => isPathUnder(resolved, root))) {
      return resolved;
    }
    throw new Error(`路径 '${originalPath}' 超出允许的受管目录范围，禁止访问`);
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
  if (normalized === "workspace" || normalized === "transient" || normalized === "exports") {
    return normalized;
  }
  if (normalized) {
    throw new Error(`不支持的显式空间: ${value}`);
  }
  return null;
}

function dedupePaths(paths: Array<string | null | undefined>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of paths) {
    if (!item) {
      continue;
    }
    const resolved = path.resolve(item);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(resolved);
  }
  return output;
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function resolvePathLike(value: string): string {
  if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(value)) {
    return value.replace(/\//g, "\\");
  }
  return path.resolve(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
