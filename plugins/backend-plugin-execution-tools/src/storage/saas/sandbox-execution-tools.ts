import {
  type ToolCaller,
  type ToolExecContext,
  type ToolExecutionResult,
} from "@ragsystem/agent-sdk";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { RunSandboxRuntime } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
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
import {
  prepareCodeExecution,
  type CodeExecutionInput,
} from "../../tools/CodeExecutionTool/code-policy.js";

export class SaaSSearchToolService {
  private readonly todos = new Map<string, TodoItem[]>();

  constructor(private readonly sandbox: RunSandboxRuntime) {}

  async glob(input: GlobInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "glob";
    try {
      const normalized = normalizeGlobInput(input);
      if ("error" in normalized) return toolError(toolName, normalized.error);
      const root = resolveSandboxPath(normalized.path, { operation: "search" });
      const pattern = validateSandboxGlob(normalized.pattern);
      const result = await this.sandbox.glob(context, {
        root: root.internalPath,
        pattern,
        recursive: normalized.recursive,
        maxResults: normalized.maxResults,
      });
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
      const result = await this.sandbox.grep(context, {
        root: root.internalPath,
        pattern: normalized.pattern,
        glob,
        caseSensitive: normalized.caseSensitive,
        maxResults: normalized.maxResults,
        contextLines: normalized.contextLines,
      });
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
  constructor(private readonly sandbox: RunSandboxRuntime) {}

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
      const result = await this.sandbox.exec(context, {
        command: plan.command,
        cwd: plan.cwd,
        timeoutSeconds: plan.timeoutSeconds,
      });
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
  constructor(private readonly sandbox: RunSandboxRuntime) {}

  async executeCode(input: CodeExecutionInput, context: ToolExecContext, _toolCaller: ToolCaller | null = null): Promise<ToolExecutionResult> {
    const toolName = "execute_code";
    const prepared = prepareCodeExecution(input, { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 300 });
    if (!prepared.ok) return prepared.result;
    const plan = prepared.plan;
    try {
      const result = await this.sandbox.executeCode(context, {
        code: plan.code,
        cwd: "/work",
        timeoutSeconds: plan.timeoutSeconds,
      });
      return toolSuccess(result.result, {
        toolName,
        summary: "代码执行成功",
        outputType: typeof result.result === "string" ? "text" : "json",
        metadata: {
          stdout: result.stdout,
          stderr: result.stderr,
          return_code: result.returnCode,
          interrupted: result.interrupted,
          tool_calls_supported: false,
          classification: plan.riskLevel,
        },
      });
    } catch (error) { return toolError(toolName, `代码执行失败: ${messageOf(error)}`); }
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
