import fs from "node:fs";
import path from "node:path";

import type { ToolExecContext } from "@ragsystem/agent-sdk";
import type { ExecutionPaths } from "../../contracts/execution/execution-environment.js";
import { createLocalExecutionPaths } from "../../contracts/execution/execution-environment.js";
import type { PathAccessPolicy } from "../../contracts/runtime/path-access-policy.js";
import { isAbsolutePathLike, isPathUnder, resolvePathLike } from "./paths.js";

export type ManagedSpace = keyof ExecutionPaths;
export type ManagedRoots = ExecutionPaths;

/** Shared path view and external-path approval boundary for execution tools. */
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
    return context.executionPaths ?? createLocalExecutionPaths(this.dataRoot, context);
  }

  getExternalCandidates(
    cwd: string | null | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string[] {
    const rawDir = normalizeString(cwd) ?? ".";
    const roots = this.roots(context);
    const candidatePath = isAbsolutePathLike(rawDir)
      ? resolvePathLike(rawDir)
      : path.resolve(roots.workspace, rawDir);
    if (pathService.isApproved(candidatePath)) return [];
    if (this.allowedWorkingRoots(context).some((root) => isPathUnder(candidatePath, root))) return [];
    return [candidatePath];
  }

  resolveWorkingDirectory(
    cwd: string | null | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string {
    const rawDir = normalizeString(cwd) ?? ".";
    const roots = this.roots(context);
    const candidate = isAbsolutePathLike(rawDir)
      ? resolvePathLike(rawDir)
      : path.resolve(roots.workspace, rawDir);
    const resolved = pathService.assertWithin(candidate, this.allowedWorkingRoots(context), rawDir);
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`路径不是目录: ${cwd ?? rawDir}`);
    return resolved;
  }

  resolveSearchRoot(rawPath: string | null | undefined, context: ToolExecContext): string {
    const raw = normalizeString(rawPath) ?? ".";
    const roots = this.roots(context);
    const candidate = isAbsolutePathLike(raw)
      ? resolvePathLike(raw)
      : path.resolve(roots.workspace, raw);
    const resolved = path.resolve(candidate);
    if (!Object.values(roots).some((root) => isPathUnder(resolved, root))) {
      throw new Error(`路径 '${raw}' 超出允许的执行目录范围；workspace=${roots.workspace}`);
    }
    if (!fs.existsSync(resolved)) throw new Error(`路径不存在: ${raw}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`路径不是目录: ${raw}`);
    return resolved;
  }

  toDisplayPath(filePath: string): string {
    return path.resolve(filePath);
  }

  private allowedWorkingRoots(context: ToolExecContext): string[] {
    const roots = this.roots(context);
    return [roots.workspace];
  }
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}
