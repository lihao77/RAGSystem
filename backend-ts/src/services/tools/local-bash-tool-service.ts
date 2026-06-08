import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RiskLevel } from "../../contracts/permissions.js";
import type { BackgroundTaskService } from "../runtime/background-task-service.js";
import type { ClientEventPublisher } from "../runtime/event-outbox/client-event-publisher.js";
import {
  buildApprovalDescription,
  categoryRisk,
  classifyCommand,
  validateCommand,
  type CommandCategory,
} from "./local-bash-tool-service/command-policy.js";
import { BashPathResolver } from "./local-bash-tool-service/paths.js";
import type { ToolExecutionResult } from "./memory-tool-service.js";
import type { RuntimeToolExecutionContext } from "../runtime/runtime-tool-types.js";
import { throwIfAborted } from "../runtime/abort.js";

const TOOL_NAME = "execute_bash";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_OUTPUT_CHARS = 50000;
const MAX_STDERR_CHARS = 2000;

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
  private readonly clientEvents: ClientEventPublisher | null;
  private readonly paths: BashPathResolver;

  constructor(options: {
    dataRoot?: string | undefined;
    defaultTimeoutSeconds?: number | undefined;
    maxTimeoutSeconds?: number | undefined;
    maxOutputChars?: number | undefined;
    bashExecutable?: string | null | undefined;
    backgroundTasks?: BackgroundTaskService | null | undefined;
    clientEvents?: ClientEventPublisher | null | undefined;
  } = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
    this.defaultTimeoutSeconds = positiveInt(options.defaultTimeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
    this.maxTimeoutSeconds = positiveInt(options.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
    this.maxOutputChars = positiveInt(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
    this.bashExecutable = options.bashExecutable === undefined ? findBashExecutable() : options.bashExecutable;
    this.backgroundTasks = options.backgroundTasks ?? null;
    this.clientEvents = options.clientEvents ?? null;
    this.paths = new BashPathResolver(this.dataRoot);
  }

  prepareExecution(input: BashExecutionInput, context: RuntimeToolExecutionContext): BashExecutionPlanResult {
    const command = normalizeString(input.command);
    if (!command) {
      return { ok: false, result: errorResult("execute_bash 缺少 command", { command: "" }) };
    }

    let cwd: string;
    try {
      cwd = this.paths.resolveWorkingDirectory(input.workingDir ?? null, input.workingDirSpace ?? null, context);
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
    return this.paths.getExternalPathApprovalCandidates(input.workingDir, context);
  }

  async executePlan(plan: BashExecutionPlan, context: RuntimeToolExecutionContext): Promise<ToolExecutionResult> {
    throwIfAborted(context.signal, "Bash execution aborted");
    if (plan.runInBackground) {
      return this.executeBackgroundPlan(plan, context);
    }
    try {
      const result = await this.runForegroundCommand(plan, context.signal);
      throwIfAborted(context.signal, "Bash execution aborted");
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
      throwIfAborted(context.signal, "Bash execution aborted");
      return errorResult(`命令执行失败: ${error instanceof Error ? error.message : String(error)}`, {
        ...plan.metadata,
      });
    }
  }

  private executeBackgroundPlan(plan: BashExecutionPlan, context: RuntimeToolExecutionContext): ToolExecutionResult {
    throwIfAborted(context.signal, "Bash execution aborted");
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
      clientEvents: this.clientEvents,
      sessionId,
      runId: normalizeString(context.runId),
      ownerTaskId: normalizeString(context.taskId),
    });
    const displayPath = this.paths.toDisplayPath(task.output_path);
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
      if (signal?.aborted) {
        reject(new Error("Bash execution aborted"));
        return;
      }
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

function positiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : fallback;
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, positiveInt(value, fallback)));
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
