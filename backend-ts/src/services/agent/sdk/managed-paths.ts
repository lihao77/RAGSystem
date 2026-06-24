/**
 * ManagedPathResolver —— 受管空间路径解析 + 边界校验（SDK 适配层专用）。
 *
 * 合并 backend-ts 旧 BashPathResolver（workingDir space）+ LocalDocumentPathManager
 *（read/write/edit space）为单一解析器。仅服务于新 SDK ToolExecutor 适配器——
 * 现有 LocalDocumentToolService / BashToolService 各自的路径解析暂不切换（不相关重构）。
 *
 * 三个受管空间（落盘 + 写入）：
 *   - workspace：agent 工作区根（agent.custom_params.workspace_root 或 session/workspace）
 *   - transient：session 级瞬态（sessions/<sid>/transient）—— SDK observation artifact 同落此
 *   - exports：run 级导出（sessions/<sid>/exports/<runId>）
 *
 * 只读消费（仅列入 read allowedRoots，不在此落盘）：uploads / visualizations / sandbox。
 *   其落盘与管理仍属 backend-ts 现有服务，本解析器只放行读取。
 *
 * 不读 SDK ToolExecContext——后者刻意最小化（无 workspaceRoot / approvedExternalPaths）。
 * 消费方（ToolExecutor 适配器）用本地 ManagedPathContext（含 workspaceRoot + approvedExternalPaths）
 * 构造后传入。assertAllowedPath 是工具安全操作文件的前提。
 */
import fs from "node:fs";
import path from "node:path";

export type ManagedSpace = "workspace" | "transient" | "exports";
export type ManagedOperation = "read" | "write" | "edit";

const DISPLAY_PATH_PREFIX = "./data/";

/** ManagedPathResolver 的运行时上下文（比 SDK ToolExecContext 更富，含 workspace/trust）。 */
export interface ManagedPathContext {
  sessionId: string | null;
  runId: string | null;
  /** 显式 workspace 根（来自 workspace trust / agent.custom_params.workspace_root）。 */
  workspaceRoot?: string | null;
  /** 审批通过的外部路径（只读 + 受控写，来自 PermissionPolicy 审批流程）。 */
  approvedExternalPaths?: string[];
  signal?: AbortSignal;
}

export interface ResolveManagedPathInput {
  /** 原始输入路径（display path / 绝对路径 / 相对路径 / 空）。 */
  filePath: string | null | undefined;
  context: ManagedPathContext;
  operation: ManagedOperation;
  /** 显式指定空间（workspace/transient/exports）。 */
  explicitSpace?: string | null;
  /** 无路径时自动分配输出文件的扩展名（默认 .txt）。 */
  suffix?: string;
  /** agent 配置的默认输出空间（来自 agent.custom_params.default_output_space）。 */
  defaultOutputSpace?: string | null;
}

export class ManagedPathResolver {
  constructor(private readonly dataRoot: string) {}

  /**
   * 解析受管路径：display path 映射 → 绝对路径校验 → 相对路径按空间根解析 → 边界校验。
   *
   * @throws 路径越界（不在任何 allowedRoot 下）时抛错。
   */
  resolveManagedPath(input: ResolveManagedPathInput): string {
    const rawPath = String(input.filePath ?? "").trim();
    const ctx = input.context;
    const op = input.operation;
    const workspaceRoot = normalizeString(ctx.workspaceRoot);

    // 无路径：按空间分配输出文件（仅 write/edit）。
    if (!rawPath) {
      if (op === "read") {
        throw new Error("读取操作必须提供 file_path");
      }
      const root = this.allocateOutputRoot({
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        workspaceRoot,
        explicitSpace: normalizeManagedSpace(input.explicitSpace),
        defaultOutputSpace: normalizeManagedSpace(input.defaultOutputSpace),
      });
      fs.mkdirSync(root, { recursive: true });
      return path.join(root, `output_${randomSuffix()}${input.suffix ?? ".txt"}`);
    }

    // display path（./data/...）映射到 dataRoot。
    const displayMapped = this.fromDisplayPath(rawPath);
    if (displayMapped) {
      return this.assertAllowed(displayMapped, ctx, workspaceRoot, rawPath, op);
    }

    // 绝对路径：直接校验。
    if (isAbsolutePathLike(rawPath)) {
      return this.assertAllowed(resolvePathLike(rawPath), ctx, workspaceRoot, rawPath, op);
    }

    // 相对路径：按显式空间或候选根解析。
    const explicitSpace = normalizeManagedSpace(input.explicitSpace);
    if (explicitSpace) {
      const candidate = path.resolve(this.spaceRoot(explicitSpace, ctx, workspaceRoot), rawPath);
      return this.assertAllowed(candidate, ctx, workspaceRoot, rawPath, op);
    }
    return this.resolveRelative(rawPath, ctx, workspaceRoot, op);
  }

  /** 绝对路径 → 供展示的 display path（./data/<relative>），dataRoot 外原样返回。 */
  toDisplayPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    const relative = path.relative(path.resolve(this.dataRoot), resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return `${DISPLAY_PATH_PREFIX}${relative.split(path.sep).join("/")}`;
    }
    return resolved;
  }

  /**
   * 绝对路径是否在 allowedRoots 内（供工具审批候选检测复用，不抛错）。
   * 返回 false 表示该路径需要审批（超出当前受管范围）。
   */
  isWithinAllowed(candidatePath: string, ctx: ManagedPathContext, operation: ManagedOperation): boolean {
    const workspaceRoot = normalizeString(ctx.workspaceRoot);
    try {
      this.assertAllowed(candidatePath, ctx, workspaceRoot, candidatePath, operation);
      return true;
    } catch {
      return false;
    }
  }

  /** 当前上下文下某空间的根目录（不创建）。workspace 无根时返回 null。 */
  spaceRoot(space: ManagedSpace, ctx: ManagedPathContext, workspaceRoot: string | null): string {
    if (space === "workspace") {
      const root = this.effectiveWorkspaceRoot(ctx.sessionId, workspaceRoot);
      if (!root) {
        throw new Error("workspace 路径缺少可用目录");
      }
      return root;
    }
    if (!ctx.sessionId) {
      throw new Error(`${space} 路径缺少 session_id`);
    }
    if (space === "transient") {
      return path.join(this.dataRoot, "sessions", ctx.sessionId, "transient");
    }
    if (!ctx.runId) {
      throw new Error("exports 路径缺少 run_id");
    }
    return path.join(this.dataRoot, "sessions", ctx.sessionId, "exports", ctx.runId);
  }

  // ────────────────────────────── 内部解析 ──────────────────────────────

  private resolveRelative(
    rawPath: string,
    ctx: ManagedPathContext,
    workspaceRoot: string | null,
    op: ManagedOperation,
  ): string {
    const candidateRoots = this.allowedRoots(ctx, workspaceRoot, op);
    if (candidateRoots.length === 0) {
      throw new Error(`路径 '${rawPath}' 缺少可用的受管根目录`);
    }
    // read：在多个候选根里找首个已存在的命中。
    if (op === "read") {
      for (const root of candidateRoots) {
        const candidate = path.resolve(root, rawPath);
        if (isPathUnder(candidate, root) && fs.existsSync(candidate)) {
          return this.assertAllowed(candidate, ctx, workspaceRoot, rawPath, op);
        }
      }
    }
    return this.assertAllowed(path.resolve(candidateRoots[0]!, rawPath), ctx, workspaceRoot, rawPath, op);
  }

  /**
   * 边界校验：resolved 在 operation 对应的 allowedRoots 内则通过，否则抛错。
   * read 放宽到 uploads/visualizations/sandbox 等只读消费根；write/edit 仅 workspace/transient/exports。
   */
  private assertAllowed(
    candidatePath: string,
    ctx: ManagedPathContext,
    workspaceRoot: string | null,
    originalPath: string,
    op: ManagedOperation,
  ): string {
    const resolved = path.resolve(candidatePath);
    const allowed = this.allowedRoots(ctx, workspaceRoot, op);
    if (allowed.some((root) => isPathUnder(resolved, root))) {
      return resolved;
    }
    throw new Error(`路径 '${originalPath}' 超出允许的受管目录范围，禁止访问`);
  }

  private allowedRoots(ctx: ManagedPathContext, workspaceRoot: string | null, operation: ManagedOperation): string[] {
    if (operation === "read") {
      return dedupePaths([
        this.effectiveWorkspaceRoot(ctx.sessionId, workspaceRoot),
        ...this.sessionReadRoots(ctx.sessionId, ctx.runId, workspaceRoot),
        this.dataRoot,
        ...(ctx.approvedExternalPaths ?? []),
      ]);
    }
    return dedupePaths([
      this.effectiveWorkspaceRoot(ctx.sessionId, workspaceRoot),
      ctx.sessionId ? path.join(this.dataRoot, "sessions", ctx.sessionId, "transient") : null,
      ctx.sessionId && ctx.runId
        ? path.join(this.dataRoot, "sessions", ctx.sessionId, "exports", ctx.runId)
        : ctx.sessionId
          ? path.join(this.dataRoot, "sessions", ctx.sessionId, "exports")
          : null,
      ...(ctx.approvedExternalPaths ?? []),
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

  private effectiveWorkspaceRoot(sessionId: string | null, workspaceRoot: string | null): string | null {
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

// ────────────────────────────── 自由函数 ──────────────────────────────

export function normalizeManagedSpace(value: unknown): ManagedSpace | null {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "workspace" || normalized === "transient" || normalized === "exports") {
    return normalized;
  }
  if (normalized) {
    throw new Error(`不支持的显式空间: ${value}`);
  }
  return null;
}

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 14).padEnd(12, "0");
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

function dedupePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
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
    result.push(resolved);
  }
  return result;
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
