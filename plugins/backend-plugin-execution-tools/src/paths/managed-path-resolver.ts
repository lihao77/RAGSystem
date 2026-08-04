import fs from "node:fs";
import path from "node:path";

import type { ToolExecContext } from "@ragsystem/agent-sdk";
import type { ExecutionPaths } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import { createLocalExecutionPaths } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { isAbsolutePathLike, isPathUnder, resolvePathLike } from "@ragsystem/backend-core/tools/shared/paths.js";

export type ManagedSpace = keyof ExecutionPaths;
export type ManagedRoots = ExecutionPaths;

/**
 * Shared Local path view.
 *
 * Relative paths have exactly one meaning: they are relative to workspace,
 * unless an explicit space is supplied. There is no display-path alias,
 * candidate-root search, or private code sandbox directory.
 */
export class ManagedPathResolver {
  private readonly dataRoot: string;

  constructor(dataRoot: string) {
    if (!dataRoot?.trim()) throw new Error("ManagedPathResolver 必须传入 dataRoot");
    this.dataRoot = path.resolve(dataRoot);
  }

  getDataRoot(): string {
    return this.dataRoot;
  }

  roots(context: ToolExecContext): ManagedRoots {
    if (context.executionPaths) {
      return context.executionPaths;
    }
    return createLocalExecutionPaths(this.dataRoot, context);
  }

  getExternalCandidates(
    workingDir: string | null | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string[] {
    const rawDir = normalizeString(workingDir);
    if (!rawDir || !isAbsolutePathLike(rawDir)) return [];
    const candidatePath = resolvePathLike(rawDir);
    if (pathService.isApproved(candidatePath)) return [];
    if (this.allowedRoots(context, "working_directory").some((root) => isPathUnder(candidatePath, root))) return [];
    return [candidatePath];
  }

  resolveWorkingDirectory(
    workingDir: string | null | undefined,
    workingDirSpace: string | null | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string {
    const rawDir = normalizeString(workingDir) ?? ".";
    const space = normalizeManagedSpace(workingDirSpace) ?? "workspace";
    const roots = this.roots(context);
    const candidate = isAbsolutePathLike(rawDir)
      ? resolvePathLike(rawDir)
      : path.resolve(roots[space], rawDir);
    const resolved = this.assertAllowedPath(candidate, context, rawDir, pathService, "working_directory");
    if (!fs.existsSync(resolved) && this.allowedRoots(context, "working_directory").some((root) => isPathUnder(resolved, root))) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    if (!fs.existsSync(resolved)) throw new Error(`工作目录不存在: ${workingDir ?? rawDir}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`路径不是目录: ${workingDir ?? rawDir}`);
    return resolved;
  }

  resolveSearchRoot(rawPath: string | null | undefined, context: ToolExecContext): string {
    const raw = normalizeString(rawPath) ?? ".";
    const roots = this.roots(context);
    const candidate = isAbsolutePathLike(raw)
      ? resolvePathLike(raw)
      : path.resolve(roots.workspace, raw);
    const resolved = this.assertAllowedPath(candidate, context, raw, null, "read");
    if (!fs.existsSync(resolved)) throw new Error(`路径不存在: ${raw}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`路径不是目录: ${raw}`);
    return resolved;
  }

  toDisplayPath(filePath: string): string {
    return path.resolve(filePath);
  }

  private allowedRoots(context: ToolExecContext, mode: "working_directory" | "read"): string[] {
    const roots = this.roots(context);
    if (mode === "working_directory") return [roots.workspace, roots.transient];
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
    if (pathService) return pathService.assertWithin(candidatePath, roots, originalPath);
    const resolved = path.resolve(candidatePath);
    if (!roots.some((root) => isPathUnder(resolved, root))) {
      throw new Error(`路径 '${originalPath}' 超出允许的执行目录范围；workspace=${this.roots(context).workspace}`);
    }
    return resolved;
  }
}

function normalizeManagedSpace(value: unknown): ManagedSpace | null {
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) return null;
  if (normalized === "workspace" || normalized === "uploads" || normalized === "artifacts" || normalized === "transient") {
    return normalized;
  }
  throw new Error(`不支持的路径空间: ${value}；请使用绝对路径或 workspace/uploads/artifacts/transient`);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}
