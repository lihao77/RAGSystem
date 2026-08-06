import {
  type ToolCaller,
  type ToolExecContext,
  type ToolExecutionResult,
} from "@ragsystem/agent-sdk";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { SandboxLeaseRuntime } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import { resolveSandboxPath, validateSandboxGlob } from "@ragsystem/backend-core/contracts/sandbox/sandbox-paths.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import {
  buildBashExecutionPlan,
  classifyBashCommand,
  type BashClassificationResult,
  type BashExecutionInput,
  type BashExecutionPlan,
  type BashExecutionPlanResult,
} from "../../tools/BashTool/bash-policy.js";
import {
  formatGlobResult,
  formatGrepResult,
  formatTodoWriteResult,
  normalizeGlobInput,
  normalizeGrepInput,
  parseTodos,
  type GlobInput,
  type GrepInput,
  type TodoItem,
} from "../../tools/shared/search-policy.js";

export class SaaSSearchToolService {
  private readonly todos = new Map<string, TodoItem[]>();

  constructor(private readonly leases: SandboxLeaseRuntime) {}

  async glob(input: GlobInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "glob";
    try {
      const normalized = normalizeGlobInput(input);
      if ("error" in normalized) return toolError(toolName, normalized.error);
      const root = resolveSandboxPath(normalized.path, { operation: "search" });
      const pattern = validateSandboxGlob(normalized.pattern);
      const result = await this.leases.withLease(context, (lease, provider) => provider.glob(lease, {
        root: root.internalPath,
        pattern,
        recursive: normalized.recursive,
        maxResults: normalized.maxResults,
        signal: context.signal,
      }));
      return formatGlobResult(root.displayPath, { pattern }, result.files, result.truncated);
    } catch (error) { return toolError(toolName, `glob 执行失败: ${messageOf(error)}`); }
  }

  async grep(input: GrepInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "grep";
    try {
      const normalized = normalizeGrepInput(input);
      if ("error" in normalized) return toolError(toolName, normalized.error);
      const root = resolveSandboxPath(normalized.path, { operation: "search" });
      const glob = validateSandboxGlob(normalized.glob);
      const result = await this.leases.withLease(context, (lease, provider) => provider.grep(lease, {
        root: root.internalPath,
        pattern: normalized.pattern,
        glob,
        caseSensitive: normalized.caseSensitive,
        maxResults: normalized.maxResults,
        contextLines: normalized.contextLines,
        signal: context.signal,
      }));
      const matches = result.matches.map((match) => ({ file: match.file, line_number: match.lineNumber, line: match.line, before: match.before, after: match.after }));
      return formatGrepResult(root.displayPath, normalized, matches, result.scannedFiles, result.truncated);
    } catch (error) { return toolError(toolName, `grep 执行失败: ${messageOf(error)}`); }
  }

  async webFetch(): Promise<ToolExecutionResult> {
    return toolError("web_fetch", "SaaS 沙箱默认 network=none，web_fetch 未启用");
  }

  todoWrite(input: { todos: unknown }, context: ToolExecContext): ToolExecutionResult {
    const key = `${context.userId ?? ""}:${context.sessionId ?? ""}`;
    const previous = this.todos.get(key) ?? [];
    const parsed = parseTodos(input.todos);
    if ("error" in parsed) return toolError("todo_write", parsed.error);
    this.todos.set(key, parsed.todos);
    return formatTodoWriteResult(previous, parsed.todos, context.sessionId?.trim() || "anonymous");
  }
}

export class SaaSBashToolService {
  constructor(private readonly leases: SandboxLeaseRuntime) {}

  buildCommandClassification(input: BashExecutionInput, agent: AgentConfig | null): BashClassificationResult {
    return classifyBashCommand(input, agent, {
      defaultTimeoutSeconds: 120,
      maxTimeoutSeconds: 600,
      backgroundSupported: false,
      backgroundUnsupportedMessage: "SaaS 沙箱第一版不支持后台 Bash",
    });
  }

  prepareExecution(input: BashExecutionInput, _context: ToolExecContext, agent: AgentConfig | null, _pathService: PathAccessPolicy): BashExecutionPlanResult {
    const classified = this.buildCommandClassification(input, agent);
    if (!classified.ok) return classified;
    try {
      const c = classified.classification;
      const cwd = resolveSandboxPath(c.workingDir, { explicitSpace: c.workingDirSpace, operation: "search" });
      return { ok: true, plan: buildBashExecutionPlan(c, cwd.internalPath, cwd.displayPath) };
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

interface CodeExecutionInput { code: string; description?: string | null; timeout?: number | null }
