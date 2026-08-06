import { normalizeString } from "@ragsystem/backend-core/utils/guards.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { BackgroundTaskPort } from "@ragsystem/backend-core/contracts/runtime/background-tasks.js";
import type { ClientEventPublisherPort } from "@ragsystem/backend-core/contracts/runtime/core-runtime-ports.js";
import { ManagedPathResolver } from "../../paths/managed-path-resolver.js";
import { RuntimeAbortError, throwIfAborted, type ToolExecContext, type ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { terminateProcessTree } from "@ragsystem/backend-core/services/runtime/process-tree.js";
import { executionPathEnvironment } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import {
  buildBashExecutionPlan,
  classifyBashCommand,
  type BashClassificationResult,
  type BashExecutionInput,
  type BashExecutionPlan,
  type BashExecutionPlanResult,
} from "./bash-policy.js";

export type {
  BashClassificationResult,
  BashCommandClassification,
  BashExecutionInput,
  BashExecutionPlan,
  BashExecutionPlanResult,
} from "./bash-policy.js";

const TOOL_NAME = "execute_bash";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_OUTPUT_CHARS = 50000;
const MAX_STDERR_CHARS = 2000;
const PROCESS_TERMINATION_WAIT_MS = 5_000;
const GROUP_KILLER_TIMEOUT_MS = 1_000;

/**
 * 命令分类（不 resolve workingDir）—— checkAccess 用。
 * prepareExecution 据此 + resolveWorkingDirectory 建 plan（含 resolved cwd）。
 * 拆分目的：checkAccess 阶段 workingDir 越界时 pathService.approved 还空（approve 在 gate 后），
 * 若此时 resolve 会抛错被吞成 deny；故 checkAccess 只分类（不 resolve），call 阶段才 resolve。
 */
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
  private readonly backgroundTasks: BackgroundTaskPort | null;
  private readonly clientEvents: ClientEventPublisherPort | null;
  private readonly paths: ManagedPathResolver;

  constructor(options: {
    dataRoot?: string | undefined;
    defaultTimeoutSeconds?: number | undefined;
    maxTimeoutSeconds?: number | undefined;
    maxOutputChars?: number | undefined;
    bashExecutable?: string | null | undefined;
    pathResolver?: ManagedPathResolver | undefined;
    backgroundTasks?: BackgroundTaskPort | null | undefined;
    clientEvents?: ClientEventPublisherPort | null | undefined;
  } = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("LocalBashToolService 必须传入已解析的 dataRoot");
    }
    this.dataRoot = path.resolve(options.dataRoot);
    this.defaultTimeoutSeconds = positiveInt(options.defaultTimeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
    this.maxTimeoutSeconds = positiveInt(options.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
    this.maxOutputChars = positiveInt(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
    this.bashExecutable = options.bashExecutable === undefined ? findBashExecutable() : options.bashExecutable;
    this.backgroundTasks = options.backgroundTasks ?? null;
    this.clientEvents = options.clientEvents ?? null;
    this.paths = options.pathResolver ?? new ManagedPathResolver(this.dataRoot);
  }

  buildCommandClassification(input: BashExecutionInput, agent: AgentConfig | null): BashClassificationResult {
    return classifyBashCommand(input, agent, {
      defaultTimeoutSeconds: this.defaultTimeoutSeconds,
      maxTimeoutSeconds: this.maxTimeoutSeconds,
      backgroundSupported: true,
    });
  }

  prepareExecution(input: BashExecutionInput, context: ToolExecContext, agent: AgentConfig | null, pathService: PathAccessPolicy): BashExecutionPlanResult {
    const classified = this.buildCommandClassification(input, agent);
    if (!classified.ok) {
      return classified;
    }
    const c = classified.classification;
    let cwd: string;
    try {
      cwd = this.paths.resolveWorkingDirectory(c.workingDir, c.workingDirSpace, context, pathService);
    } catch (error) {
      return {
        ok: false,
        result: errorResult(error instanceof Error ? error.message : String(error), {
          command: c.command,
          working_dir: c.workingDir ?? ".",
          working_dir_space: c.workingDirSpace ?? "workspace",
        }),
      };
    }
    return { ok: true, plan: buildBashExecutionPlan(c, cwd, cwd) };
  }

  getExternalCandidates(input: BashExecutionInput, context: ToolExecContext, pathService: PathAccessPolicy): string[] {
    return this.paths.getExternalCandidates(input.workingDir, context, pathService);
  }

  async executePlan(plan: BashExecutionPlan, context: ToolExecContext): Promise<ToolExecutionResult> {
    throwIfAborted(context.signal, "Bash execution aborted");
    if (plan.runInBackground) {
      return this.executeBackgroundPlan(plan, context);
    }
    try {
      const result = await this.runForegroundCommand(plan, context);
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
          execution_paths: this.paths.roots(context),
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

  private executeBackgroundPlan(plan: BashExecutionPlan, context: ToolExecContext): ToolExecutionResult {
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
      env: executionPathEnvironment(this.paths.roots(context)),
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
          execution_paths: this.paths.roots(context),
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

  private runForegroundCommand(plan: BashExecutionPlan, context: ToolExecContext): Promise<ForegroundResult> {
    const signal = context.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Bash execution aborted"));
        return;
      }
      const env = {
        ...process.env,
        ...executionPathEnvironment(this.paths.roots(context)),
        LC_ALL: process.platform === "win32" ? process.env.LC_ALL : "C.UTF-8",
      };
      // Git Bash/MSYS children do not retain a usable Windows parent chain.
      // Capture the MSYS process-group id before running the command so abort
      // can kill the whole pipeline with the MSYS `kill` builtin.
      const msysMarker = process.platform === "win32" && this.bashExecutable
        ? `__RAGSYSTEM_PGID_${randomUUID()}__=`
        : null;
      const shellCommand = msysMarker
        ? `printf '${msysMarker}%s\\n' "$$" >&2\n${plan.command}`
        : plan.command;
      const proc = this.bashExecutable
        ? spawn(this.bashExecutable, ["-c", shellCommand], {
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
      let terminating = false;
      let processClosed = false;
      let msysProcessGroupId: number | null = null;

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        signal?.removeEventListener("abort", abortHandler);
      };
      const waitForClose = (): Promise<void> => {
        if (processClosed) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onClose = (): void => {
            if (timer) clearTimeout(timer);
            resolve();
          };
          proc.once("close", onClose);
          timer = setTimeout(() => {
            proc.removeListener("close", onClose);
            reject(new Error("Bash process did not exit after termination"));
          }, PROCESS_TERMINATION_WAIT_MS);
          timer.unref?.();
        });
      };
      const terminate = async (): Promise<void> => {
        const killOperations: Promise<void>[] = [];
        if (this.bashExecutable && msysProcessGroupId !== null) {
          killOperations.push(new Promise<void>((resolve) => {
            const groupKiller = spawn(
              this.bashExecutable!,
              ["-c", `kill -KILL -- -${msysProcessGroupId}`],
              { stdio: "ignore", windowsHide: true },
            );
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              try { groupKiller.kill("SIGKILL"); } catch { /* already exited */ }
              resolve();
            }, GROUP_KILLER_TIMEOUT_MS);
            timer.unref?.();
            const finishGroupKill = (code: number | null): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (code !== null && code !== 0) {
                void terminateProcessTree(proc.pid, true).finally(resolve);
                return;
              }
              resolve();
            };
            groupKiller.once("error", () => finishGroupKill(null));
            groupKiller.once("exit", (code) => finishGroupKill(code));
          }));
        }
        killOperations.push(Promise.resolve(terminateProcessTree(proc.pid, true)));
        try {
          proc.kill("SIGKILL");
        } catch {
          // The child may have exited between the signal and this call.
        }
        await Promise.all(killOperations);
        await waitForClose();
      };
      const finishTimeout = (): void => {
        if (settled || terminating) return;
        interrupted = true;
        terminating = true;
        cleanup();
        void terminate().then(() => {
          if (settled) return;
          settled = true;
          resolve({
            stdout,
            stderr,
            returnCode: -1,
            interrupted: true,
          });
        }, () => {
          if (settled) return;
          settled = true;
          reject(new Error("Bash execution could not be terminated"));
        });
      };
      const finishAbort = (): void => {
        if (settled || terminating) return;
        interrupted = true;
        terminating = true;
        cleanup();
        void terminate().then(() => {
          if (settled) return;
          settled = true;
          reject(new RuntimeAbortError("Bash execution aborted"));
        }, () => {
          if (settled) return;
          settled = true;
          reject(new RuntimeAbortError("Bash execution aborted"));
        });
      };
      // User cancellation is explicit: force-kill the complete tree so a shell
      // wrapper cannot leave its command child running on Windows.
      const abortHandler = (): void => finishAbort();
      const timeoutTimer = setTimeout(finishTimeout, plan.timeoutSeconds * 1000);

      signal?.addEventListener("abort", abortHandler, { once: true });
      proc.stdout?.on("data", (chunk: Buffer | string) => {
        if (stdout.length <= this.maxOutputChars + 1) {
          stdout += chunk.toString();
        }
      });
      proc.stderr?.on("data", (chunk: Buffer | string) => {
        if (stderr.length <= MAX_STDERR_CHARS + 1) {
          stderr += chunk.toString();
          if (msysMarker && msysProcessGroupId === null) {
            const markerIndex = stderr.indexOf(msysMarker);
            if (markerIndex >= 0) {
              const valueStart = markerIndex + msysMarker.length;
              const valueMatch = /^(\d+)\r?\n/.exec(stderr.slice(valueStart));
              if (valueMatch?.[1]) {
                msysProcessGroupId = Number(valueMatch[1]);
                stderr = stderr.slice(0, markerIndex) + stderr.slice(valueStart + valueMatch[0].length);
              }
            }
          }
        }
      });
      proc.on("error", (error) => {
        if (settled || terminating) return;
        settled = true;
        cleanup();
        reject(error);
      });
      proc.on("close", (code) => {
        processClosed = true;
        if (settled || terminating) return;
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
): ToolExecutionResult {
  return toolSuccess(content, { toolName: TOOL_NAME, summary: input.summary, outputType: input.outputType, metadata: input.metadata });
}

function errorResult(message: string, metadata: Record<string, unknown> = {}): ToolExecutionResult {
  return toolError(TOOL_NAME, message, metadata);
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

function positiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : fallback;
}
