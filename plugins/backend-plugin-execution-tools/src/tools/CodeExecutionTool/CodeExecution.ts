import { asRecord } from "@ragsystem/backend-core/utils/guards.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { isPathUnder } from "@ragsystem/backend-core/tools/shared/paths.js";
import { ManagedPathResolver, type ManagedRoots } from "../../paths/managed-path-resolver.js";
import { executionPathEnvironment } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import {
  normalizeCodeTimeout,
  prepareCodeExecution,
  type CodeExecutionInput,
} from "./code-policy.js";

export type { CodeExecutionInput, CodeExecutionPlan, CodeExecutionPlanResult } from "./code-policy.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
/** 工具互调回调——execute_code 子进程内 call_tool 用。runtime-adapter per-run 注入。 */
export type ToolCaller = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
) => Promise<ToolExecutionResult>;

export class CodeExecutionToolService {
  private readonly dataRoot: string;
  private readonly paths: ManagedPathResolver;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxTimeoutSeconds: number;

  constructor(options: {
    dataRoot?: string | undefined;
    pathResolver?: ManagedPathResolver | undefined;
    defaultTimeoutSeconds?: number | undefined;
    maxTimeoutSeconds?: number | undefined;
  } = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("CodeExecutionToolService 必须传入已解析的 dataRoot");
    }
    this.paths = options.pathResolver ?? new ManagedPathResolver(options.dataRoot);
    this.dataRoot = this.paths.getDataRoot();
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS;
  }

  clampTimeout(value: number | null | undefined): number {
    return normalizeCodeTimeout(value, this.defaultTimeoutSeconds, this.maxTimeoutSeconds);
  }

  getManagedRoots(context: ToolExecContext): ManagedRoots {
    return this.paths.roots(context);
  }

  getExternalCandidates(input: CodeExecutionInput, context: ToolExecContext, pathService: PathAccessPolicy): string[] {
    return this.paths.getExternalCandidates(input.cwd, context, pathService);
  }

  async executeCode(
    input: CodeExecutionInput,
    context: ToolExecContext,
    toolCaller: ToolCaller | null = null,
    pathService: PathAccessPolicy | null = null,
  ): Promise<ToolExecutionResult> {
    const toolName = "execute_code";
    const prepared = prepareCodeExecution(input, {
      defaultTimeoutSeconds: this.defaultTimeoutSeconds,
      maxTimeoutSeconds: this.maxTimeoutSeconds,
    });
    if (!prepared.ok) return prepared.result;
    const plan = prepared.plan;
    const code = plan.code;
    const timeoutSeconds = plan.timeoutSeconds;
    const roots = this.getManagedRoots(context);
    const cwd = resolveCodeCwd(input.cwd, context, roots, pathService);
    for (const root of Object.values(roots)) {
      fs.mkdirSync(root, { recursive: true });
    }
    fs.mkdirSync(cwd, { recursive: true });

    const startedAt = Date.now();
    const child = spawn(resolvePythonExecutable(), ["-u", "-c", PYTHON_RUNNER], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...executionPathEnvironment(roots),
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });

    const protocolLines = createJsonLineReader((message) => {
      void this.handleProtocolMessage(message, child, context, toolCaller);
    });
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => protocolLines.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const payload = {
      code,
      roots,
      cwd,
      data_root: this.dataRoot,
    };
    child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");

    const timedOut = { value: false };
    const timer = setTimeout(() => {
      timedOut.value = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    const abortListener = () => {
      child.kill("SIGKILL");
    };
    context.signal?.addEventListener("abort", abortListener, { once: true });

    try {
      const exit = await waitForChild(child);
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abortListener);
      if (context.signal?.aborted) {
        return errorResult("代码执行失败: 执行已取消", toolName, { execution_paths: roots });
      }
      if (timedOut.value) {
        return errorResult(`代码执行失败: 代码执行超时（超过 ${timeoutSeconds} 秒）`, toolName, { execution_paths: roots });
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      protocolLines.flush();
      const parsed = protocolLines.doneMessage;
      if (!parsed) {
        return errorResult(
          `代码执行失败: 执行进程异常退出${stderr.trim() ? `: ${stderr.trim()}` : exit.code !== 0 ? ` (exit ${exit.code})` : ""}`,
          toolName,
          {
            stderr,
            exit_code: exit.code,
            execution_paths: roots,
          },
        );
      }

      if (!parsed.success) {
        return errorResult(`代码执行失败: ${parsed.error ?? "unknown error"}`, toolName, {
          stdout: parsed.stdout ?? "",
          stderr,
          exit_code: exit.code,
          execution_paths: roots,
        });
      }

      const executionTime = (Date.now() - startedAt) / 1000;
      return {
        success: true,
        toolName,
        summary: `代码执行成功，工具调用 ${parsed.tool_calls_count ?? 0} 次`,
        answer: null,
        outputType: typeof parsed.result === "string" ? "text" : "json",
        content: parsed.result,
        metadata: {
          stdout: parsed.stdout ?? "",
          stderr,
          tool_calls_count: parsed.tool_calls_count ?? 0,
          execution_time: executionTime,
          classification: plan.riskLevel,
          execution_paths: roots,
        },
        files: [],
        llmHint: null,
      };
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abortListener);
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
  }

  async callCodeCallableTool(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecContext,
    toolCaller: ToolCaller | null,
  ): Promise<unknown> {
    if (!toolCaller) {
      throw new Error("execute_code 当前缺少工具调用回调");
    }
    const result = await toolCaller(toolName, args, context);
    if (!result.success) {
      throw new Error(result.summary || String(result.content ?? "tool failed"));
    }
    return result.content;
  }

  private async handleProtocolMessage(
    message: Record<string, unknown>,
    child: ReturnType<typeof spawn>,
    context: ToolExecContext,
    toolCaller: ToolCaller | null,
  ): Promise<void> {
    if (message.type !== "tool_call") {
      return;
    }
    const requestId = typeof message.request_id === "string" ? message.request_id : "";
    const toolName = typeof message.tool_name === "string" ? message.tool_name : "";
    const args = asRecord(message.arguments) ?? {};
    try {
      const content = await this.callCodeCallableTool(toolName, args, context, toolCaller);
      child.stdin?.write(`${JSON.stringify({ type: "tool_result", request_id: requestId, success: true, content })}\n`, "utf8");
    } catch (error) {
      child.stdin?.write(
        `${JSON.stringify({
          type: "tool_result",
          request_id: requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
        "utf8",
      );
    }
  }

}

function resolvePythonExecutable(): string {
  return process.env.RAGSYSTEM_PYTHON ?? process.env.PYTHON ?? "python";
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

interface RunnerOutput {
  success: boolean;
  result?: unknown;
  error?: string;
  stdout?: string;
  tool_calls_count?: number;
}

function createJsonLineReader(onMessage: (message: Record<string, unknown>) => void): {
  doneMessage: RunnerOutput | null;
  push(chunk: Buffer): void;
  flush(): void;
} {
  let buffered = "";
  let doneMessage: RunnerOutput | null = null;
  const consumeLine = (line: string): void => {
    if (!line.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!asRecord(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (message.type === "done") {
      const nextDoneMessage: RunnerOutput = {
        success: message.success === true,
        result: message.result,
        stdout: typeof message.stdout === "string" ? message.stdout : "",
        tool_calls_count: typeof message.tool_calls_count === "number" ? message.tool_calls_count : 0,
      };
      if (typeof message.error === "string") {
        nextDoneMessage.error = message.error;
      }
      doneMessage = nextDoneMessage;
      return;
    }
    onMessage(message);
  };
  return {
    get doneMessage() {
      return doneMessage;
    },
    push(chunk: Buffer) {
      buffered += chunk.toString("utf8");
      while (true) {
        const index = buffered.indexOf("\n");
        if (index < 0) {
          break;
        }
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        consumeLine(line);
      }
    },
    flush() {
      if (buffered.trim()) {
        consumeLine(buffered);
        buffered = "";
      }
    },
  };
}

function errorResult(
  message: string,
  toolName: string,
  metadata: Record<string, unknown> = {},
): ToolExecutionResult {
  return {
    success: false,
    toolName,
    summary: message,
    answer: null,
    outputType: "error",
    content: message,
    metadata: {
      source_shape: "error",
      ...metadata,
    },
    files: [],
    llmHint: null,
  };
}

function resolveCodeCwd(
  rawCwd: string | null | undefined,
  context: ToolExecContext,
  roots: ManagedRoots,
  pathService: PathAccessPolicy | null,
): string {
  const raw = rawCwd?.trim() || ".";
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(roots.workspace, raw);
  if (pathService) return pathService.assertWithin(candidate, [roots.workspace], raw);
  if (isPathUnder(candidate, roots.workspace)) return candidate;
  throw new Error(`路径 '${raw}' 超出受管目录；外部 cwd 需要经过路径审批`);
}

const PYTHON_RUNNER = String.raw`
import builtins
import datetime
import io
import json
import os
import sys
import time
import traceback
import types
from contextlib import redirect_stdout
from pathlib import Path

payload = json.loads(sys.stdin.readline())
roots = payload["roots"]
cwd = payload.get("cwd") or roots["workspace"]
code = payload["code"]
tool_calls_count = 0

def _ensure_serializable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, set):
        return [_ensure_serializable(v) for v in value]
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _ensure_serializable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_ensure_serializable(v) for v in value]
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)

def _send(message):
    sys.__stdout__.write(json.dumps(_ensure_serializable(message), ensure_ascii=False) + "\n")
    sys.__stdout__.flush()

def _emit(message):
    _send({"type": "done", **message})

def _resolve_managed_path(raw_path, space=None):
    raw = str(raw_path)
    if os.path.isabs(raw):
        return os.path.abspath(raw)
    base = cwd if space is None else roots.get(space)
    if not base:
        raise ValueError("space 必须是 workspace 或 uploads")
    return os.path.abspath(os.path.join(base, raw))

def _path_ops_path(value):
    return _resolve_managed_path(value, "workspace")

path_ops = types.ModuleType("path_ops")
path_ops.SESSION_WORKSPACE_DIR = roots["workspace"]
path_ops.SESSION_UPLOADS_DIR = roots["uploads"]
path_ops.join = os.path.join
path_ops.basename = os.path.basename
path_ops.dirname = os.path.dirname
path_ops.splitext = os.path.splitext
path_ops.exists = lambda value: os.path.exists(_path_ops_path(value))
path_ops.isfile = lambda value: os.path.isfile(_path_ops_path(value))
path_ops.isdir = lambda value: os.path.isdir(_path_ops_path(value))
path_ops.abspath = _path_ops_path
path_ops.normpath = os.path.normpath
sys.modules["path_ops"] = path_ops

def save_file(content, filename, space="workspace"):
    resolved = _resolve_managed_path(filename, space)
    Path(resolved).parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        Path(resolved).write_bytes(content)
    elif isinstance(content, str):
        Path(resolved).write_text(content, encoding="utf-8")
    else:
        Path(resolved).write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    return resolved

def request_write_approval(path, reason="代码写文件"):
    return "approved"

def call_tool(tool_name, arguments=None):
    global tool_calls_count
    tool_calls_count += 1
    request_id = f"tool-{time.monotonic_ns()}"
    _send({
        "type": "tool_call",
        "request_id": request_id,
        "tool_name": tool_name,
        "arguments": arguments or {},
    })
    response_line = sys.stdin.readline()
    if not response_line:
        raise RuntimeError("工具调用响应为空")
    response = json.loads(response_line)
    if response.get("type") != "tool_result" or response.get("request_id") != request_id:
        raise RuntimeError("收到无效的工具调用响应")
    if not response.get("success"):
        raise RuntimeError(response.get("error") or f"工具 '{tool_name}' 执行失败")
    return response.get("content")

env = {
    "__builtins__": builtins.__dict__,
    "call_tool": call_tool,
    "save_file": save_file,
    "request_write_approval": request_write_approval,
    "DATA_DIR": roots["workspace"],
    "SESSION_WORKSPACE_DIR": roots["workspace"],
    "SESSION_UPLOADS_DIR": roots["uploads"],
    "path_ops": path_ops,
}

stdout_capture = io.StringIO()
try:
    with redirect_stdout(stdout_capture):
        exec(compile(code, "<execute_code>", "exec"), env, env)
    _emit({
        "success": True,
        "result": env.get("result"),
        "stdout": stdout_capture.getvalue(),
        "tool_calls_count": tool_calls_count,
    })
except Exception as exc:
    _emit({
        "success": False,
        "error": "".join(traceback.format_exception_only(type(exc), exc)).strip(),
        "stdout": stdout_capture.getvalue(),
        "tool_calls_count": tool_calls_count,
    })
`;
