import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RiskLevel } from "../contracts/permissions.js";
import type { BackgroundTaskService } from "./background-task-service.js";
import type { InMemoryEventBus } from "./event-bus.js";
import {
  buildApprovalDescription,
  categoryRisk,
  classifyCommand,
  validateCommand,
  type CommandCategory,
} from "./local-bash-tool-service/command-policy.js";
import type { ToolExecutionResult } from "./memory-tool-service.js";
import type { RuntimeToolExecutionContext } from "./runtime-tool-types.js";

const TOOL_NAME = "execute_bash";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_OUTPUT_CHARS = 50000;
const MAX_STDERR_CHARS = 2000;
const DISPLAY_PATH_PREFIX = "./data/";

type ManagedSpace = "workspace" | "transient" | "exports";

export interface BashExecutionInput {
  command: string;
  workingDir?: string | null;
  workingDirSpace?: string | null;
  timeout?: number | null;
  runInBackground?: boolean | null;
  description?: string | null;
}

export interface BashExecutionPlan {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  description: string;
  category: CommandCategory;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  approvalCommands: string[];
  dangerousCommands: string[];
  approvalDescription: string;
  approvalArguments: Record<string, unknown>;
  metadata: Record<string, unknown>;
  runInBackground: boolean;
}

export type BashExecutionPlanResult =
  | { ok: true; plan: BashExecutionPlan }
  | { ok: false; result: ToolExecutionResult<string> };

interface ForegroundResult {
  stdout: string;
  stderr: string;
  returnCode: number;
  interrupted: boolean;
}

export class LocalBashToolService {
  private readonly dataRoot: string;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxTimeoutSeconds: number;
  private readonly maxOutputChars: number;
  private readonly bashExecutable: string | null;
  private readonly backgroundTasks: BackgroundTaskService | null;
  private readonly eventBus: InMemoryEventBus | null;

  constructor(options: {
    dataRoot?: string | undefined;
    defaultTimeoutSeconds?: number | undefined;
    maxTimeoutSeconds?: number | undefined;
    maxOutputChars?: number | undefined;
    bashExecutable?: string | null | undefined;
    backgroundTasks?: BackgroundTaskService | null | undefined;
    eventBus?: InMemoryEventBus | null | undefined;
  } = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
    this.defaultTimeoutSeconds = positiveInt(options.defaultTimeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
    this.maxTimeoutSeconds = positiveInt(options.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
    this.maxOutputChars = positiveInt(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
    this.bashExecutable = options.bashExecutable === undefined ? findBashExecutable() : options.bashExecutable;
    this.backgroundTasks = options.backgroundTasks ?? null;
    this.eventBus = options.eventBus ?? null;
  }

  prepareExecution(input: BashExecutionInput, context: RuntimeToolExecutionContext): BashExecutionPlanResult {
    const command = normalizeString(input.command);
    if (!command) {
      return { ok: false, result: errorResult("execute_bash 缺少 command", { command: "" }) };
    }

    let cwd: string;
    try {
      cwd = this.resolveWorkingDirectory(input.workingDir ?? null, input.workingDirSpace ?? null, context);
    } catch (error) {
      return {
        ok: false,
        result: errorResult(error instanceof Error ? error.message : String(error), {
          command,
          working_dir: input.workingDir ?? ".",
          working_dir_space: input.workingDirSpace ?? "workspace",
        }),
      };
    }

    const validation = validateCommand(command);
    if (validation.status === "blocked") {
      return {
        ok: false,
        result: errorResult(`命令安全检查失败: ${validation.error}`, {
          command,
          working_dir: cwd,
          classification: "unknown",
        }),
      };
    }

    const timeoutSeconds = clampPositiveInt(input.timeout, this.defaultTimeoutSeconds, 1, this.maxTimeoutSeconds);
    const description = normalizeString(input.description) ?? "";
    const riskLevel = categoryRisk(validation.category);
    const dangerousCommands = validation.approvalCommands.filter((commandName) =>
      ["destructive", "network", "interpreter"].includes(classifyCommand(commandName)),
    );
    const approvalDescription = buildApprovalDescription({
      command,
      description,
      category: validation.category,
      dangerousCommands,
    });

    return {
      ok: true,
      plan: {
        command,
        cwd,
        timeoutSeconds,
        description,
        category: validation.category,
        riskLevel,
        approvalRequired: validation.status === "approval_required",
        approvalCommands: validation.approvalCommands,
        dangerousCommands,
        approvalDescription,
        approvalArguments: {
          command,
          working_dir: input.workingDir ?? ".",
          working_dir_space: input.workingDirSpace ?? "workspace",
          resolved_working_dir: cwd,
          description,
          classification: validation.category,
          command_segments: validation.approvalCommands,
          dangerous_command_segments: dangerousCommands,
        },
        metadata: {
          command,
          working_dir: cwd,
          working_dir_space: input.workingDirSpace ?? "workspace",
          classification: validation.category,
          risk_level: riskLevel,
          timeout_seconds: timeoutSeconds,
          ...(validation.approvalCommands.length ? { approval_required_commands: validation.approvalCommands } : {}),
        },
        runInBackground: Boolean(input.runInBackground),
      },
    };
  }

  getExternalPathApprovalCandidates(input: BashExecutionInput, context: RuntimeToolExecutionContext): string[] {
    const rawDir = normalizeString(input.workingDir);
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

  async executePlan(plan: BashExecutionPlan, context: RuntimeToolExecutionContext): Promise<ToolExecutionResult> {
    if (plan.runInBackground) {
      return this.executeBackgroundPlan(plan, context);
    }
    try {
      const result = await this.runForegroundCommand(plan, context.signal);
      let stdout = result.stdout;
      let stderr = result.stderr;
      let truncated = false;
      if (stdout.length > this.maxOutputChars) {
        stdout = stdout.slice(0, this.maxOutputChars);
        truncated = true;
      }
      if (stderr.length > MAX_STDERR_CHARS) {
        stderr = stderr.slice(0, MAX_STDERR_CHARS);
      }

      const content = {
        stdout,
        stderr,
        return_code: result.returnCode,
        interrupted: result.interrupted,
        background_task_id: null,
        background_started: false,
        classification: plan.category,
      };
      const summary = result.interrupted
        ? `命令执行超时（${plan.timeoutSeconds} 秒），进程已终止`
        : `命令执行完成，返回码 ${result.returnCode}${truncated ? "（stdout 已截断）" : ""}`;

      return successResult(content, {
        summary,
        outputType: "json",
        metadata: {
          ...plan.metadata,
          truncated,
          shell: this.bashExecutable ? "bash" : "system",
        },
      });
    } catch (error) {
      return errorResult(`命令执行失败: ${error instanceof Error ? error.message : String(error)}`, {
        ...plan.metadata,
      });
    }
  }

  private executeBackgroundPlan(plan: BashExecutionPlan, context: RuntimeToolExecutionContext): ToolExecutionResult {
    if (!this.backgroundTasks) {
      return errorResult("execute_bash 后台执行暂不可用", {
        ...plan.metadata,
        background_started: false,
      });
    }
    const sessionId = normalizeString(context.sessionId);
    if (!sessionId) {
      return errorResult("后台执行需要 session_id（无 session_id 时无法路由完成通知）", {
        ...plan.metadata,
        background_started: false,
      });
    }
    const outputDir = path.join(this.dataRoot, "sessions", sessionId, "transient");
    const task = this.backgroundTasks.spawnBash({
      command: plan.command,
      bashExecutable: this.bashExecutable,
      cwd: plan.cwd,
      outputDir,
      description: plan.description || plan.command.slice(0, 80),
      maxRuntimeSeconds: plan.timeoutSeconds,
      eventBus: this.eventBus,
      sessionId,
      runId: normalizeString(context.runId),
      ownerTaskId: normalizeString(context.taskId),
    });
    const displayPath = this.toDisplayPath(task.output_path);
    return successResult(
      {
        stdout: "",
        stderr: "",
        return_code: null,
        interrupted: false,
        background_task_id: task.task_id,
        background_started: true,
        classification: plan.category,
      },
      {
        summary: "后台任务已启动",
        outputType: "json",
        metadata: {
          ...plan.metadata,
          background_task_id: task.task_id,
          background_started: true,
          run_id: normalizeString(context.runId),
          background_output_path: displayPath,
          background_kind: task.kind,
          cancel_supported: task.cancel_supported,
          shell: this.bashExecutable ? "bash" : "system",
        },
      },
    );
  }

  private runForegroundCommand(plan: BashExecutionPlan, signal: AbortSignal | undefined): Promise<ForegroundResult> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        LC_ALL: process.platform === "win32" ? process.env.LC_ALL : "C.UTF-8",
      };
      const proc = this.bashExecutable
        ? spawn(this.bashExecutable, ["-c", plan.command], {
            cwd: plan.cwd,
            env,
            windowsHide: true,
            detached: process.platform !== "win32",
          })
        : spawn(plan.command, [], {
            cwd: plan.cwd,
            env,
            shell: true,
            windowsHide: true,
            detached: process.platform !== "win32",
          });

      let stdout = "";
      let stderr = "";
      let interrupted = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        signal?.removeEventListener("abort", abortHandler);
      };
      const killProcess = (): void => {
        interrupted = true;
        terminateProcessTree(proc.pid, false);
        forceKillTimer = setTimeout(() => {
          terminateProcessTree(proc.pid, true);
        }, 500);
      };
      const abortHandler = (): void => killProcess();
      const timeoutTimer = setTimeout(killProcess, plan.timeoutSeconds * 1000);

      signal?.addEventListener("abort", abortHandler, { once: true });
      proc.stdout?.on("data", (chunk: Buffer | string) => {
        if (stdout.length <= this.maxOutputChars + 1) {
          stdout += chunk.toString();
        }
      });
      proc.stderr?.on("data", (chunk: Buffer | string) => {
        if (stderr.length <= MAX_STDERR_CHARS + 1) {
          stderr += chunk.toString();
        }
      });
      proc.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });
      proc.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({
          stdout,
          stderr,
          returnCode: code ?? (interrupted ? -1 : 0),
          interrupted,
        });
      });
    });
  }

  private resolveWorkingDirectory(
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

  private toDisplayPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    const root = path.resolve(this.dataRoot);
    if (isPathUnder(resolved, root)) {
      return `${DISPLAY_PATH_PREFIX}${path.relative(root, resolved).replaceAll(path.sep, "/")}`;
    }
    return resolved;
  }
}

function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
  },
): ToolExecutionResult<T> {
  return {
    success: true,
    tool_name: TOOL_NAME,
    summary: input.summary,
    answer: null,
    output_type: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llm_hint: null,
  };
}

function errorResult(message: string, metadata: Record<string, unknown> = {}): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: TOOL_NAME,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
      ...metadata,
    },
    artifacts: [],
    llm_hint: null,
  };
}

function findBashExecutable(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function terminateProcessTree(pid: number | undefined, force: boolean): void {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t"];
    if (force) {
      args.push("/f");
    }
    const killer = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      // Process already exited.
    }
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

function positiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : fallback;
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, positiveInt(value, fallback)));
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
