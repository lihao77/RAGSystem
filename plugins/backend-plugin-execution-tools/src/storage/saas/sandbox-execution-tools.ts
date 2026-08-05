import {
  buildApprovalDescription,
  categoryRisk,
  classifyCommand,
  validateCommand,
  type CommandCategory,
  type RiskLevel,
  type ToolCaller,
  type ToolExecContext,
  type ToolExecutionResult,
} from "@ragsystem/agent-sdk";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { SandboxLeaseRuntime } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import { resolveSandboxPath, validateSandboxGlob } from "@ragsystem/backend-core/contracts/sandbox/sandbox-paths.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";

export class SaaSSearchToolService {
  private readonly todos = new Map<string, unknown>();

  constructor(private readonly leases: SandboxLeaseRuntime) {}

  async glob(input: GlobInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "glob";
    try {
      const root = resolveSandboxPath(input.path, { operation: "search" });
      const pattern = validateSandboxGlob(input.pattern);
      const maxResults = positiveInteger(input.maxResults, 200, 1, 5_000, "max_results");
      const result = await this.leases.withLease(context, (lease, provider) => provider.glob(lease, {
        root: root.internalPath,
        pattern,
        recursive: input.recursive ?? pattern.includes("**"),
        maxResults,
        signal: context.signal,
      }));
      return toolSuccess({ base_path: root.displayPath, pattern, files: result.files, count: result.files.length, truncated: result.truncated }, {
        toolName,
        summary: `glob 匹配 ${result.files.length} 个文件${result.truncated ? "（已截断）" : ""}`,
        outputType: "json",
        metadata: { base_path: root.displayPath, pattern, count: result.files.length, truncated: result.truncated },
      });
    } catch (error) { return toolError(toolName, `glob 执行失败: ${messageOf(error)}`); }
  }

  async grep(input: GrepInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "grep";
    try {
      if (!input.pattern.trim()) return toolError(toolName, "pattern 不能为空");
      const root = resolveSandboxPath(input.path, { operation: "search" });
      const glob = validateSandboxGlob(input.glob?.trim() || "**/*");
      const maxResults = positiveInteger(input.maxResults, 200, 1, 5_000, "max_results");
      const contextLines = positiveInteger(input.contextLines, 0, 0, 20, "context_lines");
      const result = await this.leases.withLease(context, (lease, provider) => provider.grep(lease, {
        root: root.internalPath,
        pattern: input.pattern,
        glob,
        caseSensitive: input.caseSensitive === true,
        maxResults,
        contextLines,
        signal: context.signal,
      }));
      const matches = result.matches.map((match) => ({ file: match.file, line_number: match.lineNumber, line: match.line, before: match.before, after: match.after }));
      return toolSuccess({ base_path: root.displayPath, pattern: input.pattern, matches, count: matches.length, scanned_files: result.scannedFiles, truncated: result.truncated }, {
        toolName,
        summary: `grep 找到 ${matches.length} 个匹配${result.truncated ? "（已截断）" : ""}`,
        outputType: "json",
        metadata: { base_path: root.displayPath, pattern: input.pattern, count: matches.length, scanned_files: result.scannedFiles, truncated: result.truncated },
      });
    } catch (error) { return toolError(toolName, `grep 执行失败: ${messageOf(error)}`); }
  }

  async webFetch(): Promise<ToolExecutionResult> {
    return toolError("web_fetch", "SaaS 沙箱默认 network=none，web_fetch 未启用");
  }

  todoWrite(input: { todos: unknown }, context: ToolExecContext): ToolExecutionResult {
    const key = `${context.userId ?? ""}:${context.sessionId ?? ""}`;
    const previous = this.todos.get(key) ?? [];
    this.todos.set(key, input.todos);
    return toolSuccess({ old_todos: previous, new_todos: input.todos }, { toolName: "todo_write", summary: "todo 列表已更新", outputType: "json" });
  }
}

export class SaaSBashToolService {
  constructor(private readonly leases: SandboxLeaseRuntime) {}

  buildCommandClassification(input: BashExecutionInput, _agent: AgentConfig | null): BashClassificationResult {
    const command = input.command?.trim();
    if (!command) return { ok: false, result: toolError("execute_bash", "execute_bash 缺少 command") };
    if (input.runInBackground) return { ok: false, result: toolError("execute_bash", "SaaS 沙箱第一版不支持后台 Bash") };
    const validation = validateCommand(command);
    if (validation.status === "blocked") return { ok: false, result: toolError("execute_bash", `命令安全检查失败: ${validation.error}`) };
    const timeoutSeconds = positiveInteger(input.timeout, 120, 1, 600, "timeout");
    const riskLevel = categoryRisk(validation.category);
    const dangerousCommands = validation.approvalCommands.filter((name) => ["destructive", "network", "interpreter"].includes(classifyCommand(name)));
    return { ok: true, classification: {
      command,
      description: input.description?.trim() ?? "",
      category: validation.category,
      riskLevel,
      approvalRequired: validation.status === "approval_required",
      approvalCommands: validation.approvalCommands,
      dangerousCommands,
      approvalDescription: buildApprovalDescription({ command, description: input.description?.trim() ?? "", category: validation.category, dangerousCommands }),
      timeoutSeconds,
      runInBackground: false,
      workingDir: input.workingDir ?? null,
      workingDirSpace: input.workingDirSpace ?? null,
    } };
  }

  prepareExecution(input: BashExecutionInput, _context: ToolExecContext, agent: AgentConfig | null, _pathService: PathAccessPolicy): BashExecutionPlanResult {
    const classified = this.buildCommandClassification(input, agent);
    if (!classified.ok) return classified;
    try {
      const c = classified.classification;
      const cwd = resolveSandboxPath(c.workingDir, { explicitSpace: c.workingDirSpace, operation: "search" });
      return { ok: true, plan: {
        command: c.command,
        cwd: cwd.internalPath,
        timeoutSeconds: c.timeoutSeconds,
        description: c.description,
        category: c.category,
        riskLevel: c.riskLevel,
        approvalRequired: c.approvalRequired,
        approvalCommands: c.approvalCommands,
        dangerousCommands: c.dangerousCommands,
        approvalDescription: c.approvalDescription,
        approvalArguments: { command: c.command, working_dir: cwd.displayPath, description: c.description, classification: c.category },
        metadata: { command: c.command, working_dir: cwd.displayPath, classification: c.category, risk_level: c.riskLevel, timeout_seconds: c.timeoutSeconds },
        runInBackground: false,
      } };
    } catch (error) { return { ok: false, result: toolError("execute_bash", messageOf(error)) }; }
  }

  getExternalCandidates(): string[] { return []; }

  async executePlan(plan: BashExecutionPlan, context: ToolExecContext): Promise<ToolExecutionResult> {
    try {
      const result = await this.leases.withLease(context, (lease, provider) => provider.exec(lease, {
        command: plan.command,
        cwd: plan.cwd,
        timeoutSeconds: plan.timeoutSeconds,
        signal: context.signal,
      }));
      return toolSuccess({ stdout: result.stdout, stderr: result.stderr, return_code: result.returnCode, interrupted: result.interrupted, background_task_id: null, background_started: false, classification: plan.category }, {
        toolName: "execute_bash",
        summary: result.interrupted ? `命令执行超时（${plan.timeoutSeconds} 秒）` : `命令执行完成，返回码 ${result.returnCode}`,
        outputType: "json",
        metadata: { ...plan.metadata, truncated: result.truncated === true, shell: "sandbox" },
      });
    } catch (error) { return toolError("execute_bash", `命令执行失败: ${messageOf(error)}`, plan.metadata); }
  }
}

export class SaaSCodeExecutionService {
  constructor(private readonly leases: SandboxLeaseRuntime) {}

  async executeCode(input: CodeExecutionInput, context: ToolExecContext, _toolCaller: ToolCaller | null = null): Promise<ToolExecutionResult> {
    const toolName = "execute_code";
    if (!input.code.trim()) return toolError(toolName, "代码不能为空");
    const timeoutSeconds = positiveInteger(input.timeout, 60, 1, 300, "timeout");
    try {
      const result = await this.leases.withLease(context, (lease, provider) => provider.executeCode(lease, {
        code: input.code,
        cwd: "/work",
        timeoutSeconds,
        signal: context.signal,
      }));
      return toolSuccess(result.result, {
        toolName,
        summary: "代码执行成功",
        outputType: typeof result.result === "string" ? "text" : "json",
        metadata: { stdout: result.stdout, stderr: result.stderr, return_code: result.returnCode, interrupted: result.interrupted, tool_calls_supported: false },
      });
    } catch (error) { return toolError(toolName, `代码执行失败: ${messageOf(error)}`); }
  }
}

function positiveInteger(value: number | null | undefined, fallback: number, min: number, max: number, label: string): number {
  if (value === null || value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 必须在 ${min}-${max} 之间`);
  return value;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

interface GlobInput { pattern: string; path?: string | null; recursive?: boolean | null; maxResults?: number | null }
interface GrepInput { pattern: string; path?: string | null; glob?: string | null; caseSensitive?: boolean | null; maxResults?: number | null; contextLines?: number | null }
interface BashExecutionInput {
  command: string;
  workingDir?: string | null;
  workingDirSpace?: string | null;
  timeout?: number | null;
  runInBackground?: boolean | null;
  description?: string | null;
}
interface BashExecutionPlan {
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
interface BashCommandClassification extends Omit<BashExecutionPlan, "cwd" | "approvalArguments" | "metadata"> {
  workingDir: string | null;
  workingDirSpace: string | null;
}
type BashExecutionPlanResult =
  | { ok: true; plan: BashExecutionPlan }
  | { ok: false; result: ToolExecutionResult };
type BashClassificationResult =
  | { ok: true; classification: BashCommandClassification }
  | { ok: false; result: ToolExecutionResult };
interface CodeExecutionInput { code: string; description?: string | null; timeout?: number | null }
