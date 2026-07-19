import fs from "node:fs";
import path from "node:path";

import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "../../services/agent/sdk/tool-results.js";
import type { AgentConfig } from "../../contracts/agent-config.js";
import type { IFileHistoryStore } from "../../contracts/file-history-store/index.js";
import {
  buildDataStructurePreview,
  DEFAULT_STRUCTURE_PREVIEW_DEPTH,
  DEFAULT_STRUCTURE_PREVIEW_FIELDS,
  DEFAULT_STRUCTURE_PREVIEW_ROWS,
  readPreviewLimit,
} from "./preview.js";
import { LocalDocumentPathManager, normalizeString } from "./path-manager.js";
import type { PathAccessPolicy } from "../../contracts/path-access-policy.js";

const DEFAULT_READ_MAX_LINES = 2000;

export class LocalDocumentToolService {
  private readonly pathManager: LocalDocumentPathManager;
  private readonly fileHistory: IFileHistoryStore | null;

  constructor(options: { dataRoot?: string | undefined; fileHistory?: IFileHistoryStore | null | undefined } = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("LocalDocumentToolService 必须传入已解析的 dataRoot");
    }
    const dataRoot = path.resolve(options.dataRoot);
    this.pathManager = new LocalDocumentPathManager(dataRoot);
    this.fileHistory = options.fileHistory ?? null;
  }

  readFile(
    input: {
      filePath: string;
      encoding?: string | null;
      offset?: number | null;
      limit?: number | null;
      filePathSpace?: string | null;
    },
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

      const offset = input.offset ?? 1;
      const limit = input.limit ?? DEFAULT_READ_MAX_LINES;
      if (!Number.isInteger(offset) || offset < 1) {
        return errorResult("offset 必须 >= 1", toolName);
      }
      if (!Number.isInteger(limit) || limit < 1) {
        return errorResult("limit 必须 >= 1", toolName);
      }
      const encoding = normalizeEncoding(input.encoding);
      const rawContent = fs.readFileSync(resolvedPath).toString(encoding);
      const allLines = splitPreservingLineEndings(rawContent);
      const totalLines = allLines.length;
      const startIndex = offset - 1;
      const endIndex = Math.min(startIndex + limit, totalLines);
      if (startIndex >= totalLines) {
        return successResult("", {
          summary: `offset ${offset} 超出文件总行数 ${totalLines}`,
          outputType: "text",
          metadata: {
            file_path: resolvedPath,
            display_path: this.pathManager.toDisplayPath(resolvedPath),
            file_size: stat.size,
            total_lines: totalLines,
            start_line: offset,
            end_line: offset,
            has_more: false,
            next_offset: null,
          },
          toolName,
        });
      }

      const selectedLines = allLines.slice(startIndex, endIndex);
      const content = selectedLines.join("").replace(/\n+$/, "");
      const actualEndLine = startIndex + selectedLines.length;
      const hasMore = endIndex < totalLines;
      const nextOffset = hasMore ? actualEndLine + 1 : null;
      let summary = `文件读取成功: ${input.filePath}（行 ${offset}-${actualEndLine}，共 ${totalLines} 行，${stat.size} 字节）`;
      if (hasMore) {
        summary += `；还有后续内容，可继续调用 read_file(offset=${nextOffset})`;
      } else {
        summary += "；已到文件末尾";
      }

      return successResult(content, {
        summary,
        outputType: "text",
        metadata: {
          file_path: resolvedPath,
          display_path: this.pathManager.toDisplayPath(resolvedPath),
          file_size: stat.size,
          total_lines: totalLines,
          start_line: offset,
          end_line: actualEndLine,
          has_more: hasMore,
          next_offset: nextOffset,
          user_approved_full_read: false,
        },
        toolName,
      });
    } catch (error) {
      return errorResult(`读取文件失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  writeFile(
    input: {
      content: unknown;
      filePath?: string | null;
      encoding?: string | null;
      mode?: string | null;
      filePathSpace?: string | null;
    },
    context: ToolExecContext,
    agent: AgentConfig,
    pathService: PathAccessPolicy,
  ): ToolExecutionResult {
    const toolName = "write_file";
    try {
      const mode = normalizeString(input.mode)?.toLowerCase() === "json" ? "json" : "text";
      const resolvedPath = this.pathManager.resolveManagedPath(input.filePath ?? null, {
        context,
        operation: "write",
        explicitSpace: input.filePathSpace ?? null,
        suffix: mode === "json" ? ".json" : ".txt",
        customParams: agent.custom_params,
      }, pathService);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      const encoding = normalizeEncoding(input.encoding);
      this.fileHistory?.trackEdit(context.sessionId, resolvedPath);
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

  editFile(
    input: {
      filePath: string;
      oldString: string;
      newString: string;
      encoding?: string | null;
      replaceAll?: boolean | null;
      filePathSpace?: string | null;
    },
    context: ToolExecContext,
    agent: AgentConfig,
    pathService: PathAccessPolicy,
  ): ToolExecutionResult {
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
      this.fileHistory?.trackEdit(context.sessionId, resolvedPath);
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
    input: {
      filePath: string;
      encoding?: string | null;
      maxPreviewRows?: number | null;
      maxDepth?: number | null;
      maxFields?: number | null;
      filePathSpace?: string | null;
    },
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

      const maxPreviewRows = readPreviewLimit(input.maxPreviewRows, DEFAULT_STRUCTURE_PREVIEW_ROWS, "max_preview_rows");
      if ("error" in maxPreviewRows) {
        return errorResult(maxPreviewRows.error, toolName);
      }
      const maxDepth = readPreviewLimit(input.maxDepth, DEFAULT_STRUCTURE_PREVIEW_DEPTH, "max_depth");
      if ("error" in maxDepth) {
        return errorResult(maxDepth.error, toolName);
      }
      const maxFields = readPreviewLimit(input.maxFields, DEFAULT_STRUCTURE_PREVIEW_FIELDS, "max_fields");
      if ("error" in maxFields) {
        return errorResult(maxFields.error, toolName);
      }

      const { fileType, structure } = buildDataStructurePreview(resolvedPath, {
        encoding: normalizeEncoding(input.encoding),
        maxPreviewRows: maxPreviewRows.value,
        maxDepth: maxDepth.value,
        maxFields: maxFields.value,
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
          file_path: resolvedPath,
          file_type: fileType,
          file_size: stat.size,
          max_preview_rows: maxPreviewRows.value,
          max_depth: maxDepth.value,
          max_fields: maxFields.value,
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

function splitPreservingLineEndings(content: string): string[] {
  if (!content) {
    return [];
  }
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function normalizeEncoding(value: string | null | undefined): BufferEncoding {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "utf8" || normalized === "utf-8") {
    return "utf8";
  }
  if (normalized === "utf16le" || normalized === "utf-16le") {
    return "utf16le";
  }
  if (normalized === "latin1" || normalized === "binary") {
    return "latin1";
  }
  if (normalized === "ascii") {
    return "ascii";
  }
  return "utf8";
}

function renderWritableContent(content: unknown, mode: "text" | "json"): string {
  if (mode === "json") {
    if (typeof content === "string") {
      try {
        return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
      } catch {
        return content;
      }
    }
    return `${JSON.stringify(content, null, 2)}\n`;
  }
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  return String(content);
}

function countOccurrences(content: string, search: string): number {
  if (!search) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index <= content.length) {
    const found = content.indexOf(search, index);
    if (found === -1) {
      break;
    }
    count += 1;
    index = found + search.length;
  }
  return count;
}

function buildDiffPreview(before: string, after: string, fileName: string): string {
  if (before === after) {
    return "";
  }
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const output = [`--- a/${fileName}`, `+++ b/${fileName}`];
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < maxLines; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) {
      continue;
    }
    output.push(`@@ line ${index + 1} @@`);
    if (beforeLine !== undefined) {
      output.push(`-${beforeLine}`);
    }
    if (afterLine !== undefined) {
      output.push(`+${afterLine}`);
    }
    if (output.join("\n").length > 2000) {
      output.push("... [DIFF TRUNCATED]");
      break;
    }
  }
  return output.join("\n");
}
