import fs from "node:fs";
import path from "node:path";

import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { DocumentEditHistoryPort } from "../../contracts.js";
import {
  buildDataStructurePreview,
  DEFAULT_STRUCTURE_PREVIEW_DEPTH,
  DEFAULT_STRUCTURE_PREVIEW_FIELDS,
  DEFAULT_STRUCTURE_PREVIEW_ROWS,
} from "./preview.js";
import { LocalDocumentPathManager } from "./path-manager.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import {
  buildDiffPreview,
  countOccurrences,
  normalizeEncoding,
  normalizePreviewLimit,
  normalizeReadRange,
  normalizeWriteMode,
  renderWritableContent,
  selectLineRange,
  type EditFileInput,
  type PreviewDataStructureInput,
  type ReadFileInput,
  type WriteFileInput,
} from "../shared/document-policy.js";

export class LocalDocumentToolService {
  private readonly pathManager: LocalDocumentPathManager;
  private readonly fileHistory: DocumentEditHistoryPort | null;

  constructor(options: { dataRoot?: string | undefined; fileHistory?: DocumentEditHistoryPort | null | undefined } = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("LocalDocumentToolService 必须传入已解析的 dataRoot");
    }
    const dataRoot = path.resolve(options.dataRoot);
    this.pathManager = new LocalDocumentPathManager(dataRoot);
    this.fileHistory = options.fileHistory ?? null;
  }

  readFile(
    input: ReadFileInput,
    context: ToolExecContext,
    agent: AgentConfig,
    pathService: PathAccessPolicy,
  ): ToolExecutionResult {
    const toolName = "read_file";
    try {
      const resolvedPath = this.pathManager.resolveManagedPath(input.filePath, {
        context,
        operation: "read",
        explicitSpace: input.filePathSpace ?? null,
        customParams: agent.custom_params,
      }, pathService);
      if (!fs.existsSync(resolvedPath)) {
        return errorResult(`文件不存在: ${input.filePath}`, toolName);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return errorResult(`路径不是文件: ${input.filePath}`, toolName);
      }

      let range: { offset: number; limit: number };
      try {
        range = normalizeReadRange(input.offset, input.limit);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), toolName);
      }
      const offset = range.offset;
      const limit = range.limit;
      const encoding = normalizeEncoding(input.encoding);
      const rawContent = fs.readFileSync(resolvedPath).toString(encoding);
      const selection = selectLineRange(rawContent, offset, limit);
      if (!selection.hasMore && selection.content === "" && offset > selection.totalLines) {
        return successResult("", {
          summary: `offset ${offset} 超出文件总行数 ${selection.totalLines}`,
          outputType: "text",
          metadata: {
            execution_paths: this.pathManager.executionPaths(context, agent.custom_params),
            file_path: resolvedPath,
            display_path: this.pathManager.toDisplayPath(resolvedPath),
            file_size: stat.size,
            total_lines: selection.totalLines,
            start_line: selection.startLine,
            end_line: selection.endLine,
            has_more: false,
            next_offset: null,
          },
          toolName,
        });
      }

      let summary = `文件读取成功: ${input.filePath}（行 ${selection.startLine}-${selection.endLine}，共 ${selection.totalLines} 行，${stat.size} 字节）`;
      if (selection.hasMore) {
        summary += `；还有后续内容，可继续调用 read_file(offset=${selection.nextOffset})`;
      } else {
        summary += "；已到文件末尾";
      }

      return successResult(selection.content, {
        summary,
        outputType: "text",
        metadata: {
          execution_paths: this.pathManager.executionPaths(context, agent.custom_params),
          file_path: resolvedPath,
          display_path: this.pathManager.toDisplayPath(resolvedPath),
          file_size: stat.size,
          total_lines: selection.totalLines,
          start_line: selection.startLine,
          end_line: selection.endLine,
          has_more: selection.hasMore,
          next_offset: selection.nextOffset,
          user_approved_full_read: false,
        },
        toolName,
      });
    } catch (error) {
      return errorResult(`读取文件失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  async writeFile(
    input: WriteFileInput,
    context: ToolExecContext,
    agent: AgentConfig,
    pathService: PathAccessPolicy,
  ): Promise<ToolExecutionResult> {
    const toolName = "write_file";
    try {
      const mode = normalizeWriteMode(input.mode);
      const resolvedPath = this.pathManager.resolveManagedPath(input.filePath ?? null, {
        context,
        operation: "write",
        explicitSpace: input.filePathSpace ?? null,
        suffix: mode === "json" ? ".json" : ".txt",
        customParams: agent.custom_params,
      }, pathService);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      const encoding = normalizeEncoding(input.encoding);
      await this.fileHistory?.trackEdit(context.sessionId, resolvedPath);
      fs.writeFileSync(resolvedPath, renderWritableContent(input.content, mode), { encoding });
      const stat = fs.statSync(resolvedPath);
      const displayPath = this.pathManager.toDisplayPath(resolvedPath);
      return successResult(
        {
          file_path: resolvedPath,
          display_path: displayPath,
          file_size: stat.size,
        },
        {
          summary: `文件已写入: ${displayPath}（${stat.size} 字节）`,
          outputType: "text",
          metadata: {
            execution_paths: this.pathManager.executionPaths(context, agent.custom_params),
            file_path: resolvedPath,
            display_path: displayPath,
            file_size: stat.size,
          },
          toolName,
        },
      );
    } catch (error) {
      return errorResult(`写入文件失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  async editFile(
    input: EditFileInput,
    context: ToolExecContext,
    agent: AgentConfig,
    pathService: PathAccessPolicy,
  ): Promise<ToolExecutionResult> {
    const toolName = "edit_file";
    try {
      const resolvedPath = this.pathManager.resolveManagedPath(input.filePath, {
        context,
        operation: "edit",
        explicitSpace: input.filePathSpace ?? null,
        customParams: agent.custom_params,
      }, pathService);
      if (!fs.existsSync(resolvedPath)) {
        return errorResult(`文件不存在: ${input.filePath}`, toolName);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return errorResult(`路径不是文件: ${input.filePath}`, toolName);
      }
      if (!input.oldString) {
        return errorResult("old_string 不能为空", toolName);
      }

      const encoding = normalizeEncoding(input.encoding);
      const originalContent = fs.readFileSync(resolvedPath).toString(encoding);
      const matchCount = countOccurrences(originalContent, input.oldString);
      if (matchCount === 0) {
        return errorResult("未找到匹配内容，请检查 old_string 是否与文件内容完全一致", toolName);
      }
      if (matchCount > 1 && !input.replaceAll) {
        return errorResult(
          `匹配不唯一（找到 ${matchCount} 处匹配）。请提供更多上下文使 old_string 唯一，或设 replace_all=true`,
          toolName,
        );
      }

      const updatedContent = input.replaceAll
        ? originalContent.split(input.oldString).join(input.newString)
        : originalContent.replace(input.oldString, input.newString);
      await this.fileHistory?.trackEdit(context.sessionId, resolvedPath);
      fs.writeFileSync(resolvedPath, updatedContent, { encoding });
      const updatedStat = fs.statSync(resolvedPath);
      const diffPreview = buildDiffPreview(originalContent, updatedContent, path.basename(resolvedPath));
      const displayPath = this.pathManager.toDisplayPath(resolvedPath);
      const replacements = input.replaceAll ? matchCount : 1;
      return successResult(
        {
          file_path: resolvedPath,
          display_path: displayPath,
          replacements,
          file_size: updatedStat.size,
          diff_preview: diffPreview,
        },
        {
          summary: `文件编辑成功: ${displayPath}（替换 ${replacements} 处，${updatedStat.size} 字节）`,
          outputType: "json",
          metadata: {
            execution_paths: this.pathManager.executionPaths(context, agent.custom_params),
            file_path: resolvedPath,
            display_path: displayPath,
            replacements,
            file_size: updatedStat.size,
          },
          toolName,
        },
      );
    } catch (error) {
      return errorResult(`编辑文件失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  previewDataStructure(
    input: PreviewDataStructureInput,
    context: ToolExecContext,
    agent: AgentConfig,
    pathService: PathAccessPolicy,
  ): ToolExecutionResult {
    const toolName = "preview_data_structure";
    try {
      const resolvedPath = this.pathManager.resolveManagedPath(input.filePath, {
        context,
        operation: "read",
        explicitSpace: input.filePathSpace ?? null,
        customParams: agent.custom_params,
      }, pathService);
      if (!fs.existsSync(resolvedPath)) {
        return errorResult(`文件不存在: ${input.filePath}`, toolName);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return errorResult(`路径不是文件: ${input.filePath}`, toolName);
      }

      let maxPreviewRows: number;
      let maxDepth: number;
      let maxFields: number;
      try {
        maxPreviewRows = normalizePreviewLimit(input.maxPreviewRows, DEFAULT_STRUCTURE_PREVIEW_ROWS, "max_preview_rows");
        maxDepth = normalizePreviewLimit(input.maxDepth, DEFAULT_STRUCTURE_PREVIEW_DEPTH, "max_depth");
        maxFields = normalizePreviewLimit(input.maxFields, DEFAULT_STRUCTURE_PREVIEW_FIELDS, "max_fields");
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), toolName);
      }

      const { fileType, structure } = buildDataStructurePreview(resolvedPath, {
        encoding: normalizeEncoding(input.encoding),
        maxPreviewRows,
        maxDepth,
        maxFields,
      });

      const content = {
        file_path: resolvedPath,
        file_name: path.basename(resolvedPath),
        file_type: fileType,
        file_size: stat.size,
        structure,
      };
      return successResult(content, {
        summary: `已预览文件数据结构: ${path.basename(resolvedPath)}`,
        outputType: "json",
        metadata: {
          execution_paths: this.pathManager.executionPaths(context, agent.custom_params),
          file_path: resolvedPath,
          file_type: fileType,
          file_size: stat.size,
          max_preview_rows: maxPreviewRows,
          max_depth: maxDepth,
          max_fields: maxFields,
        },
        toolName,
      });
    } catch (error) {
      return errorResult(`预览数据结构失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  getExternalCandidates(
    toolName: string,
    args: Record<string, unknown> | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string[] {
    return this.pathManager.getExternalCandidates(toolName, args, context, pathService);
  }
}

function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
    toolName: string;
  },
): ToolExecutionResult {
  return toolSuccess(content, input);
}

function errorResult(message: string, toolName: string): ToolExecutionResult {
  return toolError(toolName, message);
}
