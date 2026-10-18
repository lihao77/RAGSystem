import { normalizeString } from "@ragsystem/backend-core/utils/guards.js";
import os from "node:os";
import path from "node:path";

import type { BackgroundTaskPort } from "@ragsystem/backend-core/contracts/runtime/background-tasks.js";
import type { ClientEventPublisherPort } from "@ragsystem/backend-core/contracts/runtime/core-runtime-ports.js";
import { ManagedPathResolver } from "../../paths/managed-path-resolver.js";
import { throwIfAborted, type ToolExecContext, type ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { runLocalProcess } from "@ragsystem/backend-core/services/runtime/local-process.js";
import { executionPathEnvironment } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import { detectHostShell } from "@ragsystem/backend-core/contracts/execution/shell-detection.js";
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

const TOOL_NAME = "execute_shell";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_OUTPUT_CHARS = 50000;
const MAX_STDERR_CHARS = 10000;

/**
 * 命令分类（不 resolve cwd）—— checkAccess 用。
 * prepareExecution 据此 + resolveWorkingDirectory 建 plan（含 resolved cwd）。
 * 拆分目的：checkAccess 阶段 cwd 越界时 pathService.approved 还空（approve 在 gate 后），
 * 若此时 resolve 会抛错被吞成 deny；故 checkAccess 只分类（不 resolve），call 阶段才 resolve。
 */
interface ForegroundResult {
  stdout: string;
  stderr: string;
  returnCode: number;
  interrupted: boolean;
  truncated: boolean;
  stdoutLog?: string;
  stderrLog?: string;
}

export class LocalBashToolService {
  private readonly dataRoot: string;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxTimeoutSeconds: number;
  private readonly maxOutputChars: number;
  /** 测试注入的固定 bash 路径；undefined = 每次使用时按宿主检测（含终端类型设置覆盖）现解析。 */
  private readonly injectedBashExecutable: string | null | undefined;
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
    // shell 解析见 shell-detection（终端类型设置 > RAGSYSTEM_BASH → PATH（跳过 WSL）→ Git 固定位
    // → cmd）。服务为容器级长生命周期，惰性解析保证设置变更即时反映到实际执行，
    // 与提示词"运行环境"段同源。显式传入 bashExecutable（含 null）供测试注入固定行为。
    this.injectedBashExecutable = options.bashExecutable;
    this.backgroundTasks = options.backgroundTasks ?? null;
    this.clientEvents = options.clientEvents ?? null;
    this.paths = options.pathResolver ?? new ManagedPathResolver(this.dataRoot);
  }

  private get bashExecutable(): string | null {
    return this.injectedBashExecutable !== undefined
      ? this.injectedBashExecutable
      : detectHostShell().bashExecutable;
  }

  /** 实际执行命令的 shell 种类标识（写入结果 metadata；bash 存在时恒为 "bash"）。 */
  private get shellKind(): "bash" | "cmd" | "sh" {
    if (this.injectedBashExecutable !== undefined) {
      return this.injectedBashExecutable
        ? "bash"
        : process.platform === "win32" ? "cmd" : "sh";
    }
    return detectHostShell().shellKind;
  }

  buildCommandClassification(input: BashExecutionInput, agent: AgentConfig | null): BashClassificationResult {
    return classifyBashCommand(input, agent, {
      defaultTimeoutSeconds: this.defaultTimeoutSeconds,
      maxTimeoutSeconds: this.maxTimeoutSeconds,
      backgroundSupported: true,
      // cmd 经 /c 只执行首行（其余静默丢弃），多行命令在分类层即拒绝；bash -c 支持多行。
      // cmd 语法下 \ 不是转义、' 不是引号，& 拆段须按 cmd 语义收紧。
      multilineSupported: this.shellKind !== "cmd",
      windowsShell: this.shellKind === "cmd",
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
      cwd = this.paths.resolveWorkingDirectory(c.cwd, context, pathService);
    } catch (error) {
      return {
        ok: false,
        result: errorResult(error instanceof Error ? error.message : String(error), {
          command: c.command,
          cwd: c.cwd ?? ".",
        }),
      };
    }
    return { ok: true, plan: buildBashExecutionPlan(c, cwd, cwd) };
  }

  getExternalCandidates(input: BashExecutionInput, context: ToolExecContext, pathService: PathAccessPolicy): string[] {
    return this.paths.getExternalCandidates(input.cwd, context, pathService);
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
      let truncated = result.truncated;
      if (stdout.length > this.maxOutputChars) {
        stdout = stdout.slice(0, this.maxOutputChars);
        truncated = true;
      }
      if (stderr.length > MAX_STDERR_CHARS) {
        stderr = stderr.slice(0, MAX_STDERR_CHARS);
        truncated = true;
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
        : `命令执行完成，返回码 ${result.returnCode}${truncated ? "（输出已截断）" : ""}`;

      return successResult(content, {
        summary,
        outputType: "streams",
        metadata: {
          ...plan.metadata,
          execution_paths: this.paths.roots(context),
          truncated,
          stdout_log: result.stdoutLog,
          stderr_log: result.stderrLog,
          shell: this.shellKind,
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
      return errorResult("execute_shell 后台执行暂不可用", {
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
    const outputDir = path.join(os.tmpdir(), "ragsystem-background", sessionId);
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
      // 发起者分支（§10.4 第六轮）：完成通知路由给发起命令的线程。
      initiatorThreadKey: normalizeString(context.threadKey) ?? "root",
      initiatorChildAgentId: normalizeString(context.currentChildAgentId),
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
        outputType: "streams",
        metadata: {
          ...plan.metadata,
          execution_paths: this.paths.roots(context),
          background_task_id: task.task_id,
          background_started: true,
          run_id: normalizeString(context.runId),
          background_output_path: displayPath,
          background_kind: task.kind,
          cancel_supported: task.cancel_supported,
          shell: this.shellKind,
        },
      },
    );
  }

  private async runForegroundCommand(plan: BashExecutionPlan, context: ToolExecContext): Promise<ForegroundResult> {
    const bashExecutable = this.bashExecutable;
    const result = await runLocalProcess(bashExecutable ?? plan.command, bashExecutable ? ["-c", plan.command] : [], {
      cwd: plan.cwd,
      env: {
        ...process.env,
        ...executionPathEnvironment(this.paths.roots(context)),
        LC_ALL: process.platform === "win32" ? process.env.LC_ALL : "C.UTF-8",
      },
      signal: context.signal,
      timeoutMs: plan.timeoutSeconds * 1000,
      shell: !bashExecutable,
      msysBash: !!bashExecutable,
      // UTF-8 uses at most four bytes per code point; retain the existing character-level UI cap.
      maxStdoutBytes: (this.maxOutputChars + 1) * 4,
      maxStderrBytes: (MAX_STDERR_CHARS + 1) * 4,
      logDirectory: path.join(this.paths.roots(context).workspace, ".ragsystem", "logs", "shell"),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      returnCode: result.timedOut ? -1 : result.returnCode,
      interrupted: result.timedOut,
      truncated: result.stdoutTruncated || result.stderrTruncated,
      ...(result.stdoutLog ? { stdoutLog: result.stdoutLog } : {}),
      ...(result.stderrLog ? { stderrLog: result.stderrLog } : {}),
    };
  }

}

function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: import("@ragsystem/agent-sdk").ToolOutputType;
    metadata: Record<string, unknown>;
  },
): ToolExecutionResult {
  return toolSuccess(content, { toolName: TOOL_NAME, summary: input.summary, outputType: input.outputType, metadata: input.metadata });
}

function errorResult(message: string, metadata: Record<string, unknown> = {}): ToolExecutionResult {
  return toolError(TOOL_NAME, message, metadata);
}

function positiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : fallback;
}
