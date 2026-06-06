import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RiskLevel } from "../contracts/permissions.js";
import type { BackgroundTaskService } from "./background-task-service.js";
import type { InMemoryEventBus } from "./event-bus.js";
import type { ToolExecutionResult } from "./memory-tool-service.js";
import type { RuntimeToolExecutionContext } from "./runtime-tool-types.js";

const TOOL_NAME = "execute_bash";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_OUTPUT_CHARS = 50000;
const MAX_STDERR_CHARS = 2000;
const DISPLAY_PATH_PREFIX = "./data/";

type CommandCategory = "read_only" | "write" | "destructive" | "network" | "interpreter" | "unknown";
type ValidationStatus = "allowed" | "approval_required" | "blocked";
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

const READ_ONLY_COMMANDS = new Set([
  "grep", "find", "cat", "ls", "head", "tail", "wc",
  "echo", "sort", "uniq", "cut", "awk", "diff", "comm",
  "paste", "column", "tr", "xargs",
  "pwd", "which", "whereis", "realpath", "dirname", "basename",
  "file", "stat", "du", "df",
  "env", "printenv", "date", "uname", "id", "whoami",
  "ps", "top", "htop", "free", "uptime",
  "less", "more", "strings", "od", "xxd",
  "md5sum", "sha1sum", "sha256sum",
  "jq", "yq", "xmllint",
]);

const WRITE_COMMANDS = new Set([
  "cp", "mv", "mkdir", "rmdir", "touch", "chmod", "chown",
  "ln", "tee", "install", "sed", "tar", "zip", "unzip", "gzip", "gunzip",
]);

const DESTRUCTIVE_COMMANDS = new Set(["rm", "dd", "shred", "wipe", "format", "mkfs", "del", "fdisk", "parted", "truncate"]);
const NETWORK_COMMANDS = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "netcat", "ncat", "telnet", "ftp", "ping", "traceroute", "nslookup", "dig", "git", "svn", "hg"]);
const INTERPRETER_COMMANDS = new Set([
  "python", "python3", "python2",
  "node", "nodejs", "deno", "bun",
  "ruby", "perl", "php", "lua",
  "bash", "sh", "zsh", "fish", "dash", "ksh",
  "powershell", "pwsh", "cmd",
  "java", "javac", "scala", "groovy",
  "go", "rustc", "cargo",
  "npm", "yarn", "pnpm", "pip", "pip3",
  "make", "cmake", "ninja",
  "docker", "podman", "kubectl", "helm",
  "sudo", "su", "doas",
  "kill", "pkill", "killall",
  "shutdown", "reboot", "halt", "poweroff",
  "crontab", "at", "batch",
  "mount", "umount",
  "iptables", "ufw", "firewall-cmd",
  "systemctl", "service", "init",
  "useradd", "userdel", "usermod", "passwd", "groupadd",
]);

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
      : path.isAbsolute(rawDir)
        ? rawDir
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

function validateCommand(command: string): {
  status: ValidationStatus;
  error: string;
  approvalCommands: string[];
  category: CommandCategory;
} {
  const securityError = validateCommandSecurity(command);
  if (securityError) {
    return {
      status: "blocked",
      error: securityError,
      approvalCommands: [],
      category: "unknown",
    };
  }

  const approvalCommands: string[] = [];
  const categories: CommandCategory[] = [];
  for (const segment of splitShellChain(command)) {
    const tokens = shellSplit(segment.trim());
    if (!tokens.length) {
      continue;
    }
    const commandName = path.basename(tokens[0]!);
    const category = classifyCommand(commandName, tokens);
    categories.push(category);
    if (category !== "read_only" && !approvalCommands.includes(commandName)) {
      approvalCommands.push(commandName);
    }
  }
  const category = highestCategory(categories);
  if (approvalCommands.length) {
    return {
      status: "approval_required",
      error: `命令需要用户审批后才能执行: ${approvalCommands.join(", ")}`,
      approvalCommands,
      category,
    };
  }
  return {
    status: "allowed",
    error: "",
    approvalCommands,
    category,
  };
}

function validateCommandSecurity(command: string): string | null {
  const stripped = command.replace(/2>\s*\/dev\/null|2>&1/g, "");
  if (stripped.includes("$(") || stripped.includes("`")) {
    return "禁止命令替换: $() 或反引号";
  }
  if (/(?<![12&])>(?!>?\s*\/dev\/null)/.test(stripped)) {
    return "禁止写重定向操作符: > 或 >>";
  }
  if (/\bIFS\s*=/.test(stripped)) {
    return "禁止修改 IFS 变量";
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) {
    return "禁止包含控制字符或 null byte";
  }
  if (/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(command)) {
    return "禁止包含 Unicode 伪空格字符";
  }
  if (/--?\w+=.*\$\(|--?\w+=.*`/.test(stripped)) {
    return "禁止在 flag 参数中嵌入命令替换";
  }
  if (/\b(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONPATH|DYLD_INSERT_LIBRARIES|IFS|BASH_ENV|ENV|PROMPT_COMMAND|PS1|PS2)\s*=/.test(stripped)) {
    return "禁止修改危险环境变量（PATH/LD_PRELOAD 等）";
  }
  if (command.includes("\n") || command.includes("\r")) {
    return "禁止在命令中包含换行符";
  }
  if (/\{[^}]*\.\.[^}]*\}/.test(stripped)) {
    return "禁止花括号展开中包含路径穿越";
  }
  if (/\/proc\/[^/]*\/environ/.test(stripped)) {
    return "禁止访问 /proc/*/environ";
  }
  if (/\\[\n\r]/.test(command)) {
    return "禁止反斜杠转义换行";
  }
  return null;
}

function classifyCommand(commandName: string, tokens: string[] = []): CommandCategory {
  const name = path.basename(commandName).toLowerCase();
  const args = tokens.slice(1);
  const shortFlags = new Set<string>();
  const longFlags = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith("--")) {
      longFlags.add(arg.replace(/^-+/, ""));
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (const char of arg.slice(1)) {
        shortFlags.add(char);
      }
    }
  }

  if (name === "sed") {
    return shortFlags.has("i") || args.some((arg) => arg === "-i" || (arg.startsWith("-i") && !arg.startsWith("--")))
      ? "write"
      : "read_only";
  }
  if (name === "tar") {
    const writeOps = hasAny(shortFlags, ["x", "c", "r", "u", "d", "A"]) || hasAny(longFlags, ["extract", "get", "create", "append", "update", "delete", "concatenate"]);
    const listOps = shortFlags.has("t") || longFlags.has("list");
    return listOps && !writeOps ? "read_only" : "write";
  }
  if (name === "zip") {
    return shortFlags.has("l") || longFlags.has("list") || longFlags.has("show-stored-files") ? "read_only" : "write";
  }
  if (name === "unzip") {
    return shortFlags.has("l") || shortFlags.has("v") ? "read_only" : "write";
  }
  if (name === "gzip") {
    return shortFlags.has("l") || shortFlags.has("t") || longFlags.has("list") || longFlags.has("test") ? "read_only" : "write";
  }
  if (name === "gunzip") {
    return "write";
  }
  if (INTERPRETER_COMMANDS.has(name)) {
    return "interpreter";
  }
  if (DESTRUCTIVE_COMMANDS.has(name) || name.startsWith("mkfs.")) {
    return "destructive";
  }
  if (NETWORK_COMMANDS.has(name)) {
    return "network";
  }
  if (WRITE_COMMANDS.has(name)) {
    return "write";
  }
  if (READ_ONLY_COMMANDS.has(name)) {
    return "read_only";
  }
  return "unknown";
}

function splitShellChain(command: string): string[] {
  const chainSegments = splitByShellOperators(command, ["&&", "||", ";"]);
  return chainSegments.flatMap((segment) => splitShellPipeline(segment));
}

function splitShellPipeline(command: string): string[] {
  return splitByShellOperators(command, ["|"]);
}

function splitByShellOperators(command: string, operators: string[]): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && !inSingle) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (char === "\"" && !inSingle) {
      inDouble = !inDouble;
      current += char;
      continue;
    }
    if (!inSingle && !inDouble) {
      const matched = operators.find((operator) => command.slice(index, index + operator.length) === operator);
      if (matched) {
        segments.push(current);
        current = "";
        index += matched.length - 1;
        continue;
      }
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

function shellSplit(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function highestCategory(categories: CommandCategory[]): CommandCategory {
  const order: CommandCategory[] = ["read_only", "write", "unknown", "network", "interpreter", "destructive"];
  let highest: CommandCategory = "read_only";
  for (const category of categories) {
    if (order.indexOf(category) > order.indexOf(highest)) {
      highest = category;
    }
  }
  return highest;
}

function categoryRisk(category: CommandCategory): RiskLevel {
  if (category === "read_only") {
    return "low";
  }
  if (category === "write" || category === "unknown") {
    return "medium";
  }
  return "high";
}

function categoryLabel(category: CommandCategory): string {
  return {
    read_only: "只读命令",
    write: "写操作命令",
    destructive: "破坏性命令",
    network: "网络命令",
    interpreter: "解释器/系统控制命令",
    unknown: "未知命令",
  }[category];
}

function buildApprovalDescription(input: {
  command: string;
  description: string;
  category: CommandCategory;
  dangerousCommands: string[];
}): string {
  let description = `execute_bash 申请执行${categoryLabel(input.category)}：${input.description || input.command.slice(0, 120)}`;
  if (input.dangerousCommands.length) {
    description += "。高风险命令可能导致删除文件、下载远程内容、启动解释器/子 shell 或影响系统状态。";
  }
  return description;
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

function hasAny(values: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
