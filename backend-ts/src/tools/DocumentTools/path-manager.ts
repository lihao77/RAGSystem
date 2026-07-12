import fs from "node:fs";
import path from "node:path";

import type { ToolExecContext } from "@ragsystem/agent-sdk";
import type { PathApprovalService } from "../../services/runtime/path-service.js";
import { isAbsolutePathLike, isPathUnder, resolvePathLike } from "../shared/paths.js";

const DISPLAY_PATH_PREFIX = "./data/";

export type ManagedOperation = "read" | "write" | "edit";
type ManagedSpace = "workspace" | "transient" | "exports";

export class LocalDocumentPathManager {
  constructor(private readonly dataRoot: string) {}

  resolveManagedPath(
    filePath: string | null,
    input: {
      context: ToolExecContext;
      operation: ManagedOperation;
      explicitSpace?: string | null;
      suffix?: string | undefined;
      customParams?: { workspace_root?: string | null; default_output_space?: string | null } | null;
    },
    pathService: PathApprovalService,
  ): string {
    const rawPath = String(filePath ?? "").trim();
    if (!rawPath && input.operation === "read") {
      throw new Error("读取操作必须提供 file_path");
    }

    const sessionId = normalizeString(input.context.sessionId);
    const runId = normalizeString(input.context.runId);
    const workspaceRoot = normalizeString(input.context.workspaceRoot) ??
      normalizeString(input.customParams?.workspace_root);
    const explicitSpace = normalizeManagedSpace(input.explicitSpace);
    const defaultOutputSpace = normalizeManagedSpace(input.customParams?.default_output_space) ?? null;

    if (!rawPath) {
      const root = this.allocateOutputRoot({
        sessionId,
        runId,
        workspaceRoot,
        explicitSpace,
        defaultOutputSpace,
      });
      fs.mkdirSync(root, { recursive: true });
      return path.join(root, `output_${randomSuffix()}${input.suffix ?? ".txt"}`);
    }

    const displayMapped = this.fromDisplayPath(rawPath);
    if (displayMapped) {
      return this.assertAllowedPath(displayMapped, {
        sessionId,
        runId,
        operation: input.operation,
        workspaceRoot,
        originalPath: rawPath,
      }, pathService);
    }

    if (isAbsolutePathLike(rawPath)) {
      return this.assertAllowedPath(resolvePathLike(rawPath), {
        sessionId,
        runId,
        operation: input.operation,
        workspaceRoot,
        originalPath: rawPath,
      }, pathService);
    }

    if (explicitSpace) {
      const candidate = path.resolve(this.managedSpaceRoot(explicitSpace, { sessionId, runId, workspaceRoot }), rawPath);
      return this.assertAllowedPath(candidate, {
        sessionId,
        runId,
        operation: input.operation,
        workspaceRoot,
        originalPath: rawPath,
      }, pathService);
    }

    const candidateRoots = this.relativeCandidateRoots({ sessionId, runId, operation: input.operation, workspaceRoot });
    if (!candidateRoots.length) {
      throw new Error(`路径 '${rawPath}' 缺少可用的受管根目录`);
    }
    if (input.operation === "read") {
      for (const root of candidateRoots) {
        const candidate = path.resolve(root, rawPath);
        if (isPathUnder(candidate, root) && fs.existsSync(candidate)) {
          return this.assertAllowedPath(candidate, {
            sessionId,
            runId,
            operation: input.operation,
            workspaceRoot,
            originalPath: rawPath,
          }, pathService);
        }
      }
    }

    return this.assertAllowedPath(path.resolve(candidateRoots[0]!, rawPath), {
      sessionId,
      runId,
      operation: input.operation,
      workspaceRoot,
      originalPath: rawPath,
    }, pathService);
  }

  /**
   * 越界外部路径候选（工具 checkAccess 产 ask 用）：绝对外部路径 + 未批准 + 不在受管根 → 候选。
   * 返回非空时 checkAccess 应 ask（signals.candidatePaths），gate handler 审批后 pathService.approve。
   */
  getExternalCandidates(
    toolName: string,
    args: Record<string, unknown> | undefined,
    context: ToolExecContext,
    pathService: PathApprovalService,
  ): string[] {
    const operation = documentOperationForTool(toolName);
    if (!operation) {
      return [];
    }
    const rawPath = normalizeString(args?.file_path) ?? normalizeString(args?.filePath);
    if (!rawPath || rawPath.startsWith(DISPLAY_PATH_PREFIX) || !isAbsolutePathLike(rawPath)) {
      return [];
    }
    const candidatePath = resolvePathLike(rawPath);
    if (pathService.isApproved(candidatePath)) {
      return [];
    }
    const sessionId = normalizeString(context.sessionId);
    const runId = normalizeString(context.runId);
    const workspaceRoot = normalizeString(context.workspaceRoot);
    const roots = this.allowedRoots({ sessionId, runId, operation, workspaceRoot });
    if (roots.some((root) => isPathUnder(candidatePath, root))) {
      return [];
    }
    return [candidatePath];
  }

  toDisplayPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    const relative = path.relative(this.dataRoot, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return `${DISPLAY_PATH_PREFIX}${relative.split(path.sep).join("/")}`;
    }
    return resolved;
  }

  private assertAllowedPath(
    candidatePath: string,
    input: {
      sessionId: string | null;
      runId: string | null;
      operation: ManagedOperation;
      workspaceRoot: string | null;
      originalPath: string;
    },
    pathService: PathApprovalService,
  ): string {
    const allowedRoots = this.allowedRoots({
      sessionId: input.sessionId,
      runId: input.runId,
      operation: input.operation,
      workspaceRoot: input.workspaceRoot,
    });
    return pathService.assertWithin(candidatePath, allowedRoots, input.originalPath);
  }

  private relativeCandidateRoots(input: {
    sessionId: string | null;
    runId: string | null;
    operation: ManagedOperation;
    workspaceRoot: string | null;
  }): string[] {
    if (input.operation === "read") {
      return dedupePaths([
        this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
        ...this.sessionReadRoots(input.sessionId, input.runId, input.workspaceRoot),
        this.dataRoot,
      ]);
    }
    return dedupePaths([
      this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
      input.sessionId ? path.join(this.dataRoot, "sessions", input.sessionId, "transient") : null,
      input.sessionId && input.runId
        ? path.join(this.dataRoot, "sessions", input.sessionId, "exports", input.runId)
        : input.sessionId
          ? path.join(this.dataRoot, "sessions", input.sessionId, "exports")
          : null,
    ]);
  }

  allowedRoots(input: {
    sessionId: string | null;
    runId: string | null;
    operation: ManagedOperation;
    workspaceRoot: string | null;
  }): string[] {
    if (input.operation === "read") {
      return dedupePaths([
        this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
        ...this.sessionReadRoots(input.sessionId, input.runId, input.workspaceRoot),
        this.dataRoot,
      ]);
    }
    return dedupePaths([
      this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
      input.sessionId ? path.join(this.dataRoot, "sessions", input.sessionId, "transient") : null,
      input.sessionId && input.runId
        ? path.join(this.dataRoot, "sessions", input.sessionId, "exports", input.runId)
        : input.sessionId
          ? path.join(this.dataRoot, "sessions", input.sessionId, "exports")
          : null,
    ]);
  }

  private sessionReadRoots(sessionId: string | null, runId: string | null, workspaceRoot: string | null): string[] {
    if (!sessionId) {
      return [];
    }
    const sessionRoot = path.join(this.dataRoot, "sessions", sessionId);
    return dedupePaths([
      path.join(sessionRoot, "sandbox"),
      this.effectiveWorkspaceRoot(sessionId, workspaceRoot),
      path.join(sessionRoot, "transient"),
      path.join(sessionRoot, "uploads"),
      path.join(sessionRoot, "visualizations"),
      runId ? path.join(sessionRoot, "exports", runId) : null,
      path.join(sessionRoot, "exports"),
      sessionRoot,
    ]);
  }

  private managedSpaceRoot(
    space: ManagedSpace,
    input: { sessionId: string | null; runId: string | null; workspaceRoot: string | null },
  ): string {
    if (space === "workspace") {
      const root = this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot);
      if (!root) {
        throw new Error("workspace 路径缺少可用目录");
      }
      return root;
    }
    if (!input.sessionId) {
      throw new Error(`${space} 路径缺少 session_id`);
    }
    if (space === "transient") {
      return path.join(this.dataRoot, "sessions", input.sessionId, "transient");
    }
    if (!input.runId) {
      throw new Error("exports 路径缺少 run_id");
    }
    return path.join(this.dataRoot, "sessions", input.sessionId, "exports", input.runId);
  }

  private allocateOutputRoot(input: {
    sessionId: string | null;
    runId: string | null;
    workspaceRoot: string | null;
    explicitSpace: ManagedSpace | null;
    defaultOutputSpace: ManagedSpace | null;
  }): string {
    const space = input.explicitSpace ?? input.defaultOutputSpace ?? "transient";
    if (space === "workspace") {
      const root = this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot);
      if (!root) {
        throw new Error("workspace 输出缺少可用目录");
      }
      return root;
    }
    if (!input.sessionId) {
      return path.join(this.dataRoot, "sessions", "anonymous", "transient");
    }
    if (space === "exports") {
      if (!input.runId) {
        throw new Error("exports 输出缺少 run_id");
      }
      return path.join(this.dataRoot, "sessions", input.sessionId, "exports", input.runId);
    }
    return path.join(this.dataRoot, "sessions", input.sessionId, "transient");
  }

  effectiveWorkspaceRoot(sessionId: string | null, workspaceRoot: string | null): string | null {
    if (workspaceRoot) {
      return path.resolve(workspaceRoot);
    }
    return sessionId ? path.join(this.dataRoot, "sessions", sessionId, "workspace") : null;
  }

  private fromDisplayPath(filePath: string): string | null {
    if (!filePath.startsWith(DISPLAY_PATH_PREFIX)) {
      return null;
    }
    return path.join(this.dataRoot, filePath.slice(DISPLAY_PATH_PREFIX.length));
  }
}

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 14).padEnd(12, "0");
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

function documentOperationForTool(toolName: string): ManagedOperation | null {
  if (toolName === "read_file") {
    return "read";
  }
  if (toolName === "write_file") {
    return "write";
  }
  if (toolName === "edit_file") {
    return "edit";
  }
  return null;
}

function dedupePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    if (!item) {
      continue;
    }
    const resolved = path.resolve(item);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}
