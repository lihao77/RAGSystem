import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  RuntimeToolCall,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
  ToolExecutionResult,
} from "../../services/runtime/runtime-tool-types.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
const DISPLAY_PATH_PREFIX = "./data/";

export interface CodeExecutionInput {
  code: string;
  description?: string | null;
  timeout?: number | null;
}

export class CodeExecutionToolService {
  private readonly dataRoot: string;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxTimeoutSeconds: number;
  private runtimeTools: RuntimeToolExecutor | null = null;

  constructor(options: {
    dataRoot?: string | undefined;
    defaultTimeoutSeconds?: number | undefined;
    maxTimeoutSeconds?: number | undefined;
  } = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS;
  }

  clampTimeout(value: number | null | undefined): number {
    if (value === null || value === undefined || !Number.isInteger(value)) {
      return this.defaultTimeoutSeconds;
    }
    return Math.max(1, Math.min(this.maxTimeoutSeconds, value));
  }

  setRuntimeTools(runtimeTools: RuntimeToolExecutor | null): void {
    this.runtimeTools = runtimeTools;
  }

  async executeCode(input: CodeExecutionInput, context: RuntimeToolExecutionContext): Promise<ToolExecutionResult> {
    const toolName = "execute_code";
    const code = input.code;
    if (!code.trim()) {
      return errorResult("代码不能为空", toolName);
    }
    const safetyError = validateCodeSafety(code);
    if (safetyError) {
      return errorResult(`代码安全检查失败: ${safetyError}`, toolName);
    }

    const timeoutSeconds = this.clampTimeout(input.timeout);
    const roots = this.buildRoots(context);
    for (const root of Object.values(roots)) {
      fs.mkdirSync(root, { recursive: true });
    }

    const startedAt = Date.now();
    const child = spawn(resolvePythonExecutable(), ["-u", "-c", PYTHON_RUNNER], {
      cwd: roots.sandbox,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });

    const protocolLines = createJsonLineReader((message) => {
      void this.handleProtocolMessage(message, child, context);
    });
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => protocolLines.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const payload = {
      code,
      roots,
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
        return errorResult("代码执行失败: 执行已取消", toolName);
      }
      if (timedOut.value) {
        return errorResult(`代码执行失败: 代码执行超时（超过 ${timeoutSeconds} 秒）`, toolName);
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      protocolLines.flush();
      const parsed = protocolLines.doneMessage;
      if (!parsed) {
        return errorResult(
          `代码执行失败: 沙箱进程异常退出${stderr.trim() ? `: ${stderr.trim()}` : exit.code !== 0 ? ` (exit ${exit.code})` : ""}`,
          toolName,
          {
            stderr,
            exit_code: exit.code,
          },
        );
      }

      if (!parsed.success) {
        return errorResult(`代码执行失败: ${parsed.error ?? "unknown error"}`, toolName, {
          stdout: parsed.stdout ?? "",
          stderr,
          exit_code: exit.code,
        });
      }

      const executionTime = (Date.now() - startedAt) / 1000;
      return {
        success: true,
        tool_name: toolName,
        summary: `代码执行成功，工具调用 ${parsed.tool_calls_count ?? 0} 次`,
        answer: null,
        output_type: typeof parsed.result === "string" ? "text" : "json",
        content: parsed.result,
        metadata: {
          stdout: parsed.stdout ?? "",
          stderr,
          tool_calls_count: parsed.tool_calls_count ?? 0,
          execution_time: executionTime,
          classification: classifyCodeRisk(code),
        },
        artifacts: [],
        llm_hint: null,
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
    context: RuntimeToolExecutionContext,
  ): Promise<unknown> {
    if (!this.runtimeTools) {
      throw new Error("execute_code 当前缺少工具调用桥");
    }
    const result = await this.runtimeTools.executeTool(
      {
        toolName,
        arguments: args,
      },
      {
        ...context,
        caller: "code_execution",
      },
    );
    if (!result.success) {
      throw new Error(result.summary || String(result.content ?? "tool failed"));
    }
    return result.content;
  }

  private async handleProtocolMessage(
    message: Record<string, unknown>,
    child: ReturnType<typeof spawn>,
    context: RuntimeToolExecutionContext,
  ): Promise<void> {
    if (message.type !== "tool_call") {
      return;
    }
    const requestId = typeof message.request_id === "string" ? message.request_id : "";
    const toolName = typeof message.tool_name === "string" ? message.tool_name : "";
    const args = asRecord(message.arguments) ?? {};
    try {
      const content = await this.callCodeCallableTool(toolName, args, context);
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

  private buildRoots(context: RuntimeToolExecutionContext): Record<string, string> {
    const sessionId = normalizeString(context.sessionId) ?? "anonymous";
    const runId = normalizeString(context.runId);
    const workspaceRoot = normalizeString(context.workspaceRoot) ?? normalizeString(asRecord(context.agent?.custom_params)?.workspace_root);
    const sessionRoot = path.join(this.dataRoot, "sessions", sessionId);
    const exportsRoot = runId ? path.join(sessionRoot, "exports", runId) : path.join(sessionRoot, "exports");
    return {
      workspace: path.resolve(workspaceRoot ?? path.join(sessionRoot, "workspace")),
      transient: path.join(sessionRoot, "transient"),
      uploads: path.join(sessionRoot, "uploads"),
      visualizations: path.join(sessionRoot, "visualizations"),
      exports: exportsRoot,
      sandbox: path.join(sessionRoot, "sandbox"),
    };
  }
}

function resolvePythonExecutable(): string {
  return process.env.RAGSYSTEM_PYTHON ?? process.env.PYTHON ?? "python";
}

function validateCodeSafety(code: string): string | null {
  const forbiddenModules = ["os", "sys", "subprocess", "shutil", "socket"];
  for (const line of code.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    for (const moduleName of forbiddenModules) {
      if (new RegExp(`(^|\\s)import\\s+${escapeRegExp(moduleName)}(\\s|,|$)`).test(trimmed)) {
        return `禁止导入模块: ${moduleName}`;
      }
      if (new RegExp(`(^|\\s)from\\s+${escapeRegExp(moduleName)}(\\.|\\s)`).test(trimmed)) {
        return `禁止导入模块: ${moduleName}`;
      }
    }
    for (const [pattern, label] of [
      [/__import__/, "__import__"],
      [/(?<![.\w])eval\s*\(/, "eval("],
      [/(?<![.\w])exec\s*\(/, "exec("],
      [/(?<![.\w])globals\s*\(/, "globals("],
      [/(?<![.\w])locals\s*\(/, "locals("],
      [/(?<![.\w])compile\s*\(/, "compile("],
    ] as Array<[RegExp, string]>) {
      if (pattern.test(trimmed)) {
        return `禁止使用: ${label}`;
      }
    }
  }
  return null;
}

function classifyCodeRisk(code: string): "read_only" | "write" {
  const lowered = code.toLowerCase();
  return lowered.includes("call_tool(") || lowered.includes("open(") || lowered.includes("save_file(") ? "write" : "read_only";
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
): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
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

export function readCodeExecutionArguments(value: Record<string, unknown> | undefined): CodeExecutionInput {
  return {
    code: typeof value?.code === "string" ? value.code : "",
    description: normalizeString(value?.description),
    timeout: asInteger(value?.timeout),
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PYTHON_RUNNER = String.raw`
import ast
import base64
import collections
import copy
import csv
import datetime
import decimal
import functools
import hashlib
import io
import itertools
import json
import math
import operator
import re
import statistics
import string
import struct
import textwrap
import time
import sys
import traceback
from contextlib import redirect_stdout
from pathlib import Path

payload = json.loads(sys.stdin.readline())
roots = payload["roots"]
code = payload["code"]
tool_calls_count = 0

ALLOWED_MODULES = {
    "math": math,
    "json": json,
    "re": re,
    "csv": csv,
    "datetime": datetime,
    "collections": collections,
    "itertools": itertools,
    "functools": functools,
    "statistics": statistics,
    "time": time,
    "io": io,
    "string": string,
    "decimal": decimal,
    "operator": operator,
    "copy": copy,
    "textwrap": textwrap,
    "hashlib": hashlib,
    "base64": base64,
    "struct": struct,
    "ast": ast,
}
ALLOWED_IMPORT_NAMES = set(ALLOWED_MODULES.keys()) | {
    "collections.abc", "datetime", "math", "json", "re", "csv", "itertools", "functools", "statistics",
    "_datetime", "_collections", "_collections_abc", "_functools", "_itertools", "_statistics",
    "_json", "json.decoder", "json.encoder", "json.scanner", "time", "_strptime", "_csv",
    "ast", "_ast", "_io", "io", "_decimal", "_pydecimal", "numbers", "_hashlib", "_blake2",
    "_sha256", "_sha512", "_sha1", "_sha3", "_md5", "binascii", "copyreg", "_copy", "_struct",
    "_operator", "_textwrap", "_string",
}

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

def _is_under(candidate, root):
    candidate_path = Path(candidate).resolve()
    root_path = Path(root).resolve()
    try:
        candidate_path.relative_to(root_path)
        return True
    except ValueError:
        return candidate_path == root_path

def _allowed_roots(operation):
    base = [roots["workspace"], roots["transient"], roots["exports"], roots["sandbox"]]
    if operation == "read":
        base.extend([roots["uploads"], roots["visualizations"]])
    return [str(Path(item).resolve()) for item in base if item]

def _resolve_path(raw_path, operation="read", explicit_space=None):
    raw = str(raw_path)
    if raw.startswith("./data/"):
        candidate = Path(payload["data_root"]) / raw[len("./data/"):]
    elif explicit_space:
        if explicit_space not in ("workspace", "transient", "exports"):
            raise ValueError("space 必须是 workspace/transient/exports 之一")
        candidate = Path(roots[explicit_space]) / raw
    elif Path(raw).is_absolute():
        candidate = Path(raw)
    else:
        ordered = _allowed_roots("read" if operation == "read" else "write")
        if operation == "read":
            existing = None
            for root in ordered:
                maybe = Path(root) / raw
                if maybe.exists():
                    existing = maybe
                    break
            candidate = existing or (Path(roots["workspace"]) / raw)
        else:
            candidate = Path(roots["sandbox"]) / raw
    resolved = str(candidate.resolve())
    if not any(_is_under(resolved, root) for root in _allowed_roots(operation)):
        raise PermissionError("路径超出允许的受管目录范围，禁止访问")
    return resolved

class SafePathOps:
    join = staticmethod(lambda *parts: str(Path(parts[0]).joinpath(*parts[1:])) if parts else "")
    basename = staticmethod(lambda value: Path(value).name)
    dirname = staticmethod(lambda value: str(Path(value).parent))
    splitext = staticmethod(lambda value: (str(Path(value).with_suffix("")), Path(value).suffix))
    exists = staticmethod(lambda value: Path(_resolve_path(value, "read")).exists())
    isfile = staticmethod(lambda value: Path(_resolve_path(value, "read")).is_file())
    isdir = staticmethod(lambda value: Path(_resolve_path(value, "read")).is_dir())
    abspath = staticmethod(lambda value: _resolve_path(value, "read"))
    normpath = staticmethod(lambda value: str(Path(value)))

def safe_open(raw_path, mode="r", encoding=None, **kwargs):
    normalized = mode.replace("t", "")
    is_write = any(flag in normalized for flag in ("w", "a", "x", "+"))
    resolved = _resolve_path(raw_path, "write" if is_write else "read")
    if is_write:
        Path(resolved).parent.mkdir(parents=True, exist_ok=True)
    open_kwargs = {}
    if encoding is not None:
        open_kwargs["encoding"] = encoding
    elif "b" not in mode:
        open_kwargs["encoding"] = "utf-8"
    return open(resolved, mode, **{**open_kwargs, **kwargs})

def save_file(content, filename, space="workspace"):
    resolved = _resolve_path(filename, "write", explicit_space=space)
    Path(resolved).parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        Path(resolved).write_bytes(content)
    elif isinstance(content, str):
        Path(resolved).write_text(content, encoding="utf-8")
    else:
        Path(resolved).write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    data_root = Path(payload["data_root"]).resolve()
    try:
        rel = Path(resolved).resolve().relative_to(data_root)
        return "./data/" + str(rel).replace("\\", "/")
    except ValueError:
        return resolved

def request_write_approval(path, reason="沙箱代码写文件"):
    _resolve_path(path, "write")
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

def _safe_import(name, *args, **kwargs):
    root = name.split(".")[0]
    if name not in ALLOWED_IMPORT_NAMES and root not in ALLOWED_IMPORT_NAMES:
        raise ImportError(f"禁止导入模块: {name}")
    return __import__(name, *args, **kwargs)

safe_builtins = {
    "__import__": _safe_import,
    "print": print, "len": len, "range": range, "enumerate": enumerate, "zip": zip,
    "map": map, "filter": filter, "sum": sum, "min": min, "max": max, "abs": abs,
    "round": round, "sorted": sorted, "reversed": reversed, "any": any, "all": all,
    "isinstance": isinstance, "issubclass": issubclass, "hasattr": hasattr, "callable": callable,
    "ascii": ascii, "getattr": getattr, "setattr": setattr, "delattr": delattr,
    "id": id, "hash": hash, "repr": repr, "format": format, "iter": iter, "next": next,
    "chr": chr, "ord": ord, "hex": hex, "oct": oct, "bin": bin, "pow": pow, "divmod": divmod,
    "slice": slice, "int": int, "float": float, "str": str, "bool": bool, "list": list,
    "dict": dict, "set": set, "tuple": tuple, "frozenset": frozenset, "bytes": bytes,
    "bytearray": bytearray, "complex": complex, "type": type, "object": object,
    "property": property, "staticmethod": staticmethod, "classmethod": classmethod, "super": super,
    "Exception": Exception, "BaseException": BaseException, "ValueError": ValueError,
    "TypeError": TypeError, "KeyError": KeyError, "IndexError": IndexError,
    "AttributeError": AttributeError, "RuntimeError": RuntimeError, "StopIteration": StopIteration,
    "ZeroDivisionError": ZeroDivisionError, "OverflowError": OverflowError,
    "PermissionError": PermissionError, "NotImplementedError": NotImplementedError,
    "FileNotFoundError": FileNotFoundError, "IOError": IOError, "ArithmeticError": ArithmeticError,
    "LookupError": LookupError, "True": True, "False": False, "None": None,
}

env = {
    "__builtins__": safe_builtins,
    **ALLOWED_MODULES,
    "call_tool": call_tool,
    "open": safe_open,
    "save_file": save_file,
    "request_write_approval": request_write_approval,
    "SANDBOX_DIR": roots["sandbox"],
    "DATA_DIR": roots["workspace"],
    "SESSION_WORKSPACE_DIR": roots["workspace"],
    "SESSION_TRANSIENT_DIR": roots["transient"],
    "SESSION_UPLOADS_DIR": roots["uploads"],
    "SESSION_VISUALIZATIONS_DIR": roots["visualizations"],
    "SESSION_EXPORTS_DIR": roots["exports"],
    "path_ops": SafePathOps,
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
