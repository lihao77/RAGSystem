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
  previewLine,
  type GlobInput,
  type GrepInput,
  type TodoItem,
} from "../../tools/shared/search-policy.js";
import {
  prepareCodeExecution,
  type CodeExecutionInput,
} from "../../tools/CodeExecutionTool/code-policy.js";
import { MAX_ERROR_REPORT_CHARS, truncateTail } from "../../tools/CodeExecutionTool/CodeExecution.js";

export class SandboxSearchToolService {
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
      return formatGlobResult(root.displayPath, { pattern }, result.files, result.truncated, {}, result.totalFiles);
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
      // 行预览在模型-facing 边界统一施加（2000B/UTF-8 边界），兼容旧版沙箱镜像未预览的长行。
      const matches = result.matches.map((match) => ({
        file: match.file,
        line_number: match.lineNumber,
        line: previewLine(match.line),
        before: match.before.map((line) => previewLine(line)),
        after: match.after.map((line) => previewLine(line)),
      }));
      return formatGrepResult(root.displayPath, normalized, matches, result.scannedFiles, result.truncated, {}, result.totalMatches);
    } catch (error) { return toolError(toolName, `grep 执行失败: ${messageOf(error)}`); }
  }

  async webFetch(): Promise<ToolExecutionResult> {
    return toolError("web_fetch", "Sandbox 沙箱默认 network=none，web_fetch 未启用");
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

export class SandboxBashToolService {
  constructor(private readonly sandbox: RunSandboxRuntime) {}

  buildCommandClassification(input: BashExecutionInput, agent: AgentConfig | null): BashClassificationResult {
    return classifyBashCommand(input, agent, {
      defaultTimeoutSeconds: 120,
      maxTimeoutSeconds: 600,
      backgroundSupported: false,
      backgroundUnsupportedMessage: "Sandbox 沙箱第一版不支持后台 shell 命令",
    });
  }

  prepareExecution(input: BashExecutionInput, _context: ToolExecContext, agent: AgentConfig | null, _pathService: PathAccessPolicy): BashExecutionPlanResult {
    const classified = this.buildCommandClassification(input, agent);
    if (!classified.ok) return classified;
    try {
      const c = classified.classification;
      const cwd = resolveSandboxPath(c.cwd, { operation: "search" });
      return { ok: true, plan: buildBashExecutionPlan(c, cwd.internalPath, cwd.displayPath) };
    } catch (error) { return { ok: false, result: toolError("execute_shell", messageOf(error)) }; }
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
        toolName: "execute_shell",
        summary: result.interrupted ? `命令执行超时（${plan.timeoutSeconds} 秒）` : `命令执行完成，返回码 ${result.returnCode}`,
        outputType: "streams",
        metadata: { ...plan.metadata, truncated: result.truncated === true, shell: "sandbox" },
      });
    } catch (error) { return toolError("execute_shell", `命令执行失败: ${messageOf(error)}`, plan.metadata); }
  }
}

export class SandboxCodeExecutionService {
  constructor(private readonly sandbox: RunSandboxRuntime) {}

  async executeCode(input: CodeExecutionInput, context: ToolExecContext, _toolCaller: ToolCaller | null = null): Promise<ToolExecutionResult> {
    const toolName = "execute_code";
    const prepared = prepareCodeExecution(input, { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 300 });
    if (!prepared.ok) return prepared.result;
    const plan = prepared.plan;
    try {
      const cwd = resolveSandboxPath(input.cwd, { operation: "search" });
      const result = await this.sandbox.executeCode(context, {
        code: plan.code,
        cwd: cwd.internalPath,
        timeoutSeconds: plan.timeoutSeconds,
      });
      if (result.interrupted || result.returnCode !== 0) {
        // 沙箱侧直接跑 python，未捕获异常的完整 traceback 在 stderr 里——带回模型视野，而不是误报成功。
        // 失败 content 会被下游无条件 inline 进模型上下文，超限保尾截断（traceback 异常行在尾部），与 local 侧同上限。
        const summary = result.interrupted
          ? `代码执行失败: 代码执行超时（超过 ${plan.timeoutSeconds} 秒）`
          : `代码执行失败: 进程退出码 ${result.returnCode}`;
        const stderrText = result.stderr.trim();
        const stdoutText = result.stdout.trim();
        const failure = toolError(
          toolName,
          [
            summary,
            ...(stderrText ? [`[stderr]\n${truncateTail(stderrText, MAX_ERROR_REPORT_CHARS)}`] : []),
            ...(stdoutText ? [`[stdout]\n${truncateTail(stdoutText, MAX_ERROR_REPORT_CHARS)}`] : []),
          ].join("\n\n"),
          {
            stdout: result.stdout,
            stderr: result.stderr,
            return_code: result.returnCode,
            interrupted: result.interrupted,
            truncated: result.truncated === true
              || stderrText.length > MAX_ERROR_REPORT_CHARS
              || stdoutText.length > MAX_ERROR_REPORT_CHARS,
            classification: plan.riskLevel,
            cwd: cwd.displayPath,
          },
        );
        failure.summary = summary;
        return failure;
      }
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
          cwd: cwd.displayPath,
        },
      });
    } catch (error) { return toolError(toolName, `代码执行失败: ${messageOf(error)}`); }
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
