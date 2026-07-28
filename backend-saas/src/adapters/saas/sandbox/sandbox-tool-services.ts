import { randomUUID } from "node:crypto";
import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";

import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import type { CodeExecutionPort, CommandExecutionPort, DocumentToolPort, WorkspaceSearchPort } from "@ragsystem/backend-core/contracts/runtime/tool-ports.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { BashExecutionInput, BashExecutionPlan, BashExecutionPlanResult, BashClassificationResult } from "@ragsystem/backend-core/tools/BashTool/BashExecution.js";
import { buildApprovalDescription, categoryRisk, classifyCommand, validateCommand } from "@ragsystem/backend-core/tools/BashTool/command-policy.js";
import type { CodeExecutionInput, ToolCaller } from "@ragsystem/backend-core/tools/CodeExecutionTool/CodeExecution.js";
import { resolveSandboxPath, validateSandboxGlob } from "./sandbox-paths.js";
import { SandboxLeaseManager } from "./sandbox-lease-manager.js";

const DEFAULT_READ_LINES = 2_000;
const MAX_TOOL_FILE_BYTES = 16 * 1024 * 1024;

export class SaaSSandboxDocumentToolService implements DocumentToolPort {
  constructor(private readonly leases: SandboxLeaseManager) {}

  async readFile(input: ReadInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "read_file";
    try {
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "read" });
      const offset = positiveInteger(input.offset, 1, 1, Number.MAX_SAFE_INTEGER, "offset");
      const limit = positiveInteger(input.limit, DEFAULT_READ_LINES, 1, 10_000, "limit");
      const result = await this.leases.withLease(context, (lease, provider) => provider.readFile(lease, {
        path: file.internalPath,
        encoding: normalizeEncoding(input.encoding),
        maxBytes: MAX_TOOL_FILE_BYTES,
        signal: context.signal,
      }));
      const lines = result.content.split(/\r?\n/);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const endLine = selected.length ? offset + selected.length - 1 : offset;
      const hasMore = offset - 1 + selected.length < lines.length;
      return toolSuccess(selected.join("\n"), {
        toolName,
        summary: `文件读取成功: ${file.displayPath}`,
        outputType: "text",
        metadata: {
          file_path: file.displayPath,
          display_path: file.displayPath,
          file_size: result.size,
          total_lines: lines.length,
          start_line: offset,
          end_line: endLine,
          has_more: hasMore,
          next_offset: hasMore ? endLine + 1 : null,
        },
      });
    } catch (error) {
      return toolError(toolName, `读取文件失败: ${messageOf(error)}`);
    }
  }

  async writeFile(input: WriteInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "write_file";
    try {
      const mode = input.mode?.trim().toLowerCase() === "json" ? "json" : "text";
      const defaultName = `generated-${randomUUID()}${mode === "json" ? ".json" : ".txt"}`;
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "write", defaultName });
      const content = mode === "json" && typeof input.content !== "string"
        ? JSON.stringify(input.content, null, 2)
        : String(input.content ?? "");
      const result = await this.leases.withLease(context, (lease, provider) => provider.writeFile(lease, {
        path: file.internalPath,
        content,
        encoding: normalizeEncoding(input.encoding),
        signal: context.signal,
      }));
      return toolSuccess({ file_path: file.displayPath, display_path: file.displayPath, file_size: result.size }, {
        toolName,
        summary: `文件写入成功: ${file.displayPath}`,
        outputType: "json",
        metadata: { file_path: file.displayPath, display_path: file.displayPath, file_size: result.size },
      });
    } catch (error) {
      return toolError(toolName, `写入文件失败: ${messageOf(error)}`);
    }
  }

  async editFile(input: EditInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "edit_file";
    try {
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "write" });
      if (!input.oldString) return toolError(toolName, "old_string 不能为空");
      const result = await this.leases.withLease(context, (lease, provider) => provider.editFile(lease, {
        path: file.internalPath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll === true,
        encoding: normalizeEncoding(input.encoding),
        signal: context.signal,
      }));
      return toolSuccess({ file_path: file.displayPath, display_path: file.displayPath, replacements: result.replacements }, {
        toolName,
        summary: `文件编辑成功: ${file.displayPath}`,
        outputType: "json",
        metadata: { file_path: file.displayPath, display_path: file.displayPath, file_size: result.size, replacements: result.replacements },
      });
    } catch (error) {
      return toolError(toolName, `编辑文件失败: ${messageOf(error)}`);
    }
  }

  async previewDataStructure(input: PreviewInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "preview_data_structure";
    try {
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "read" });
      const maxPreviewRows = positiveInteger(input.maxPreviewRows, 5, 1, 1_000, "max_preview_rows");
      const maxDepth = positiveInteger(input.maxDepth, 3, 1, 50, "max_depth");
      const maxFields = positiveInteger(input.maxFields, 20, 1, 10_000, "max_fields");
      const result = await this.leases.withLease(context, (lease, provider) => provider.previewFile(lease, {
        path: file.internalPath,
        encoding: normalizeEncoding(input.encoding),
        maxBytes: MAX_TOOL_FILE_BYTES,
        maxPreviewRows,
        maxDepth,
        maxFields,
        signal: context.signal,
      }));
      const content = { file_path: file.displayPath, file_name: file.displayPath.split("/").at(-1), file_type: result.fileType, file_size: result.fileSize, structure: result.structure };
      return toolSuccess(content, {
        toolName,
        summary: `已预览文件数据结构: ${file.displayPath}`,
        outputType: "json",
        metadata: { file_path: file.displayPath, file_type: result.fileType, file_size: result.fileSize, max_preview_rows: maxPreviewRows, max_depth: maxDepth, max_fields: maxFields },
      });
    } catch (error) {
      return toolError(toolName, `预览数据结构失败: ${messageOf(error)}`);
    }
  }

  getExternalCandidates(): string[] { return []; }

}

export class SaaSSandboxSearchToolService implements WorkspaceSearchPort {
  private readonly todos = new Map<string, unknown>();
  constructor(private readonly leases: SandboxLeaseManager) {}

  async glob(input: GlobInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "glob";
    try {
      const root = resolveSandboxPath(input.path, { operation: "search" });
      const pattern = validateSandboxGlob(input.pattern);
      const maxResults = positiveInteger(input.maxResults, 200, 1, 5_000, "max_results");
      const result = await this.leases.withLease(context, (lease, provider) => provider.glob(lease, {
        root: root.internalPath, pattern, recursive: input.recursive ?? pattern.includes("**"), maxResults, signal: context.signal,
      }));
      return toolSuccess({ base_path: root.displayPath, pattern, files: result.files, count: result.files.length, truncated: result.truncated }, {
        toolName, summary: `glob 匹配 ${result.files.length} 个文件${result.truncated ? "（已截断）" : ""}`, outputType: "json",
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
        root: root.internalPath, pattern: input.pattern, glob, caseSensitive: input.caseSensitive === true, maxResults, contextLines, signal: context.signal,
      }));
      const matches = result.matches.map((match) => ({ file: match.file, line_number: match.lineNumber, line: match.line, before: match.before, after: match.after }));
      return toolSuccess({ base_path: root.displayPath, pattern: input.pattern, matches, count: matches.length, scanned_files: result.scannedFiles, truncated: result.truncated }, {
        toolName, summary: `grep 找到 ${matches.length} 个匹配${result.truncated ? "（已截断）" : ""}`, outputType: "json",
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

export class SaaSSandboxBashToolService implements CommandExecutionPort {
  constructor(private readonly leases: SandboxLeaseManager) {}

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
      command, description: input.description?.trim() ?? "", category: validation.category, riskLevel,
      approvalRequired: validation.status === "approval_required", approvalCommands: validation.approvalCommands,
      dangerousCommands, approvalDescription: buildApprovalDescription({ command, description: input.description?.trim() ?? "", category: validation.category, dangerousCommands }),
      timeoutSeconds, runInBackground: false, workingDir: input.workingDir ?? null, workingDirSpace: input.workingDirSpace ?? null,
    } };
  }

  prepareExecution(input: BashExecutionInput, _context: ToolExecContext, agent: AgentConfig | null, _pathService: PathAccessPolicy): BashExecutionPlanResult {
    const classified = this.buildCommandClassification(input, agent);
    if (!classified.ok) return classified;
    try {
      const c = classified.classification;
      const cwd = resolveSandboxPath(c.workingDir, { explicitSpace: c.workingDirSpace, operation: "search" });
      return { ok: true, plan: {
        command: c.command, cwd: cwd.internalPath, timeoutSeconds: c.timeoutSeconds, description: c.description,
        category: c.category, riskLevel: c.riskLevel, approvalRequired: c.approvalRequired, approvalCommands: c.approvalCommands,
        dangerousCommands: c.dangerousCommands, approvalDescription: c.approvalDescription, approvalArguments: {
          command: c.command, working_dir: cwd.displayPath, description: c.description, classification: c.category,
        }, metadata: { command: c.command, working_dir: cwd.displayPath, classification: c.category, risk_level: c.riskLevel, timeout_seconds: c.timeoutSeconds },
        runInBackground: false,
      } };
    } catch (error) { return { ok: false, result: toolError("execute_bash", messageOf(error)) }; }
  }

  getExternalCandidates(): string[] { return []; }

  async executePlan(plan: BashExecutionPlan, context: ToolExecContext): Promise<ToolExecutionResult> {
    try {
      const result = await this.leases.withLease(context, (lease, provider) => provider.exec(lease, {
        command: plan.command, cwd: plan.cwd, timeoutSeconds: plan.timeoutSeconds, signal: context.signal,
      }));
      return toolSuccess({ stdout: result.stdout, stderr: result.stderr, return_code: result.returnCode, interrupted: result.interrupted, background_task_id: null, background_started: false, classification: plan.category }, {
        toolName: "execute_bash", summary: result.interrupted ? `命令执行超时（${plan.timeoutSeconds} 秒）` : `命令执行完成，返回码 ${result.returnCode}`,
        outputType: "json", metadata: { ...plan.metadata, truncated: result.truncated === true, shell: "sandbox" },
      });
    } catch (error) { return toolError("execute_bash", `命令执行失败: ${messageOf(error)}`, plan.metadata); }
  }
}

export class SaaSSandboxCodeExecutionService implements CodeExecutionPort {
  private toolCaller: ToolCaller | null = null;
  constructor(private readonly leases: SandboxLeaseManager) {}
  setToolCaller(caller: ToolCaller | null): void { this.toolCaller = caller; }

  async executeCode(input: CodeExecutionInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "execute_code";
    if (!input.code.trim()) return toolError(toolName, "代码不能为空");
    const timeoutSeconds = positiveInteger(input.timeout, 60, 1, 300, "timeout");
    try {
      const result = await this.leases.withLease(context, (lease, provider) => provider.executeCode(lease, {
        code: input.code, cwd: "/work", timeoutSeconds, signal: context.signal,
      }));
      return toolSuccess(result.result, {
        toolName, summary: "代码执行成功", outputType: typeof result.result === "string" ? "text" : "json",
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

function normalizeEncoding(value: string | null | undefined): string {
  const encoding = value?.trim().toLowerCase() || "utf-8";
  if (!["utf-8", "utf8", "ascii", "latin1", "base64", "hex"].includes(encoding)) throw new Error(`不支持的编码: ${encoding}`);
  return encoding;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

interface ReadInput { filePath: string; encoding?: string | null; offset?: number | null; limit?: number | null; filePathSpace?: string | null }
interface WriteInput { content: unknown; filePath?: string | null; encoding?: string | null; mode?: string | null; filePathSpace?: string | null }
interface EditInput { filePath: string; oldString: string; newString: string; encoding?: string | null; replaceAll?: boolean | null; filePathSpace?: string | null }
interface PreviewInput { filePath: string; encoding?: string | null; maxPreviewRows?: number | null; maxDepth?: number | null; maxFields?: number | null; filePathSpace?: string | null }
interface GlobInput { pattern: string; path?: string | null; recursive?: boolean | null; maxResults?: number | null }
interface GrepInput { pattern: string; path?: string | null; glob?: string | null; caseSensitive?: boolean | null; maxResults?: number | null; contextLines?: number | null }
