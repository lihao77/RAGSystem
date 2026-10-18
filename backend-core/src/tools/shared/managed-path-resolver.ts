import fs from "node:fs";
import os from "node:os";
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

  getSearchRootCandidates(
    rawPath: string | null | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string[] {
    const raw = normalizeString(rawPath);
    if (!raw) return [];
    const roots = this.roots(context);
    const candidatePath = isAbsolutePathLike(raw)
      ? resolvePathLike(raw)
      : path.resolve(roots.workspace, raw);
    if (pathService.isReadApproved?.(candidatePath)) return [];
    if (pathService.isApproved(candidatePath)) return [];
    if (this.readAllowedRoots(context).some((root) => isPathUnder(candidatePath, root))) return [];
    return [candidatePath];
  }

  /**
   * 解析搜索目标（对齐 dsh grep 的 "File or directory to search" 语义）。
   * 目录 → cwd=目录、目标 "."（行为与旧 resolveSearchRoot 一致）；allowFile 时
   * 文件也接受 → cwd=父目录、目标为文件名（rg 原生支持单文件目标，输出路径相对
   * cwd）。glob 的发现语义只对目录树有意义，不传 allowFile 时文件仍报错。
   */
  resolveSearchTarget(
    rawPath: string | null | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy | undefined,
    options: { allowFile?: boolean } = {},
  ): { cwd: string; target: string; resolved: string } {
    const raw = normalizeString(rawPath) ?? ".";
    const roots = this.roots(context);
    const candidate = isAbsolutePathLike(raw)
      ? resolvePathLike(raw)
      : path.resolve(roots.workspace, raw);
    const resolved = path.resolve(candidate);
    if (pathService) {
      if (!pathService.isReadApproved?.(resolved)) pathService.assertWithin(resolved, this.readAllowedRoots(context), raw);
    } else if (!Object.values(roots).some((root) => isPathUnder(resolved, root))) {
      throw new Error(`路径 '${raw}' 超出允许的执行目录范围；workspace=${roots.workspace}`);
    }
    if (!fs.existsSync(resolved)) throw new Error(`路径不存在: ${raw}`);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return { cwd: resolved, target: ".", resolved };
    if (options.allowFile && stat.isFile()) {
      return { cwd: path.dirname(resolved), target: path.basename(resolved), resolved };
    }
    throw new Error(options.allowFile ? `路径不是文件或目录: ${raw}` : `路径不是目录: ${raw}`);
  }

  /** 读语义界内根,与 read_file 的 LocalDocumentPathManager.allowedRoots(read) 对齐。 */
  private readAllowedRoots(context: ToolExecContext): string[] {
    return [...Object.values(this.roots(context)), os.tmpdir()];
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
