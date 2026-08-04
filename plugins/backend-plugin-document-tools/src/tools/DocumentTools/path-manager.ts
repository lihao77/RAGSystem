import fs from "node:fs";
import path from "node:path";

import type { ToolExecContext } from "@ragsystem/agent-sdk";
import type { ExecutionPaths } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import { createLocalExecutionPaths } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { isAbsolutePathLike, isPathUnder, resolvePathLike } from "@ragsystem/backend-core/tools/shared/paths.js";

export type ManagedOperation = "read" | "write" | "edit";
export type ManagedSpace = keyof ExecutionPaths;

/**
 * Document tools share the same four-directory view as shell and code tools.
 * Relative paths have exactly one meaning: workspace, unless a space is
 * explicitly selected. This class does not search candidate roots or create
 * display aliases.
 */
export class LocalDocumentPathManager {
  constructor(private readonly dataRoot: string) {
    if (!dataRoot?.trim()) throw new Error("LocalDocumentPathManager 必须传入 dataRoot");
  }

  resolveManagedPath(
    filePath: string | null,
    input: {
      context: ToolExecContext;
      operation: ManagedOperation;
      explicitSpace?: string | null;
      suffix?: string | undefined;
      customParams?: { workspace_root?: string | null; default_output_space?: string | null } | null;
    },
    pathService: PathAccessPolicy,
  ): string {
    const rawPath = String(filePath ?? "").trim();
    const roots = this.roots(input.context, input.customParams);
    const explicitSpace = normalizeManagedSpace(input.explicitSpace);
    const defaultOutputSpace = normalizeManagedSpace(input.customParams?.default_output_space);

    if ((explicitSpace === "uploads" || explicitSpace === "artifacts") && input.operation !== "read") {
      throw new Error(`${explicitSpace} 是只读空间，禁止写入或编辑`);
    }
    if (!rawPath && input.operation === "read") {
      throw new Error("读取操作必须提供 file_path");
    }

    if (!rawPath) {
      const outputSpace = explicitSpace ?? defaultOutputSpace ?? "transient";
      if (outputSpace === "uploads" || outputSpace === "artifacts") {
        throw new Error(`${outputSpace} 是只读空间，不能作为输出目录`);
      }
      const root = roots[outputSpace];
      fs.mkdirSync(root, { recursive: true });
      return path.join(root, `output_${randomSuffix()}${input.suffix ?? ".txt"}`);
    }

    const base = explicitSpace ? roots[explicitSpace] : roots.workspace;
    const candidate = isAbsolutePathLike(rawPath)
      ? resolvePathLike(rawPath)
      : path.resolve(base, rawPath);
    return this.assertAllowedPath(candidate, roots, input.operation, rawPath, pathService);
  }

  getExternalCandidates(
    toolName: string,
    args: Record<string, unknown> | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string[] {
    const operation = documentOperationForTool(toolName);
    if (!operation) return [];
    const rawPath = normalizeString(args?.file_path) ?? normalizeString(args?.filePath);
    if (!rawPath || !isAbsolutePathLike(rawPath)) return [];
    const candidatePath = resolvePathLike(rawPath);
    if (pathService.isApproved(candidatePath)) return [];
    const roots = this.roots(context, null);
    if (this.allowedRoots(roots, operation).some((root) => isPathUnder(candidatePath, root))) return [];
    return [candidatePath];
  }

  toDisplayPath(filePath: string): string {
    return path.resolve(filePath);
  }

  executionPaths(
    context: ToolExecContext,
    customParams?: { workspace_root?: string | null } | null,
  ): ExecutionPaths {
    return this.roots(context, customParams);
  }

  private roots(
    context: ToolExecContext,
    customParams: { workspace_root?: string | null } | null | undefined,
  ): ExecutionPaths {
    if (context.executionPaths) return context.executionPaths;
    return createLocalExecutionPaths(this.dataRoot, {
      sessionId: context.sessionId,
      runId: context.runId,
      workspaceRoot: normalizeString(context.workspaceRoot) ?? normalizeString(customParams?.workspace_root),
    });
  }

  private assertAllowedPath(
    candidatePath: string,
    roots: ExecutionPaths,
    operation: ManagedOperation,
    originalPath: string,
    pathService: PathAccessPolicy,
  ): string {
    return pathService.assertWithin(candidatePath, this.allowedRoots(roots, operation), originalPath);
  }

  private allowedRoots(roots: ExecutionPaths, operation: ManagedOperation): string[] {
    if (operation === "read") return Object.values(roots);
    return [roots.workspace, roots.transient];
  }
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}

function normalizeManagedSpace(value: unknown): ManagedSpace | null {
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) return null;
  if (normalized === "uploads" || normalized === "workspace" || normalized === "artifacts" || normalized === "transient") {
    return normalized;
  }
  throw new Error(`不支持的显式空间: ${value}；请使用 workspace/uploads/artifacts/transient`);
}

function documentOperationForTool(toolName: string): ManagedOperation | null {
  if (toolName === "read_file") return "read";
  if (toolName === "write_file") return "write";
  if (toolName === "edit_file") return "edit";
  return null;
}

export function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}
