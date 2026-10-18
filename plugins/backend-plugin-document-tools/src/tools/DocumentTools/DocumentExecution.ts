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
import type { ExecutionEnvironmentCapability } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import {
  READ_FILE_CHAR_BUDGET,
  READ_FILE_MAX_LINE_CHARS,
  buildDiffPreview,
  crlfDominant,
  findMatchLineNumbers,
  isTextualEncoding,
  normalizeEncoding,
  normalizeLineEndings,
  normalizePreviewLimit,
  normalizeReadRange,
  normalizeWriteMode,
  renderWritableContent,
  restoreCrlf,
  scanStreamWindow,
  selectLineRange,
  type EditFileInput,
  type PreviewDataStructureInput,
  type ReadFileInput,
  type WriteFileInput,
} from "../shared/document-policy.js";

export class LocalDocumentToolService {
  private readonly pathManager: LocalDocumentPathManager;
  private readonly fileHistory: DocumentEditHistoryPort | null;

  constructor(options: {
    dataRoot?: string | undefined;
    executionEnvironment?: ExecutionEnvironmentCapability | null | undefined;
    fileHistory?: DocumentEditHistoryPort | null | undefined;
  } = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("LocalDocumentToolService 必须传入已解析的 dataRoot");
    }
    const dataRoot = path.resolve(options.dataRoot);
    this.pathManager = new LocalDocumentPathManager(dataRoot, options.executionEnvironment ?? null);
    this.fileHistory = options.fileHistory ?? null;
  }

  /**
   * read_file：文本编码走流式行窗口（行缓冲有界，巨型单行/大文件不整读进内存），
   * 输出行号化文本 + 分页 footer；base64/hex 等二进制类编码无行语义，整读原样返回。
   */
  async readFile(
    input: ReadFileInput,
    context: ToolExecContext,
    agent: AgentConfig,
    pathService: PathAccessPolicy,
  ): Promise<ToolExecutionResult> {
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
      if (!isTextualEncoding(encoding)) {
        // base64/hex 无行语义：整读原样返回（仅字符预算截断），不做行号化渲染，offset 不适用。
        const raw = fs.readFileSync(resolvedPath).toString(encoding);
        const truncated = raw.length > READ_FILE_CHAR_BUDGET;
        const content = truncated ? raw.slice(0, READ_FILE_CHAR_BUDGET) : raw;
        return successResult(content, {
          summary: `文件读取成功: ${input.filePath}（${stat.size} 字节，${encoding} 编码；二进制类编码无行语义，offset 不适用）${truncated ? `；已截断至前 ${READ_FILE_CHAR_BUDGET} 字符` : ""}`,
          outputType: "text",
          metadata: {
            execution_paths: this.pathManager.executionPaths(context, agent.custom_params),
            file_path: resolvedPath,
            display_path: this.pathManager.toDisplayPath(resolvedPath),
            file_size: stat.size,
            total_lines: 1,
            start_line: 1,
            end_line: 1,
            has_more: false,
            next_offset: null,
            char_truncated: truncated,
            truncated_lines: 0,
          },
          toolName,
        });
      }
      const selection = await scanStreamWindow(fs.createReadStream(resolvedPath, { encoding }), offset, limit);
      if (offset > selection.totalLines) {
        // 空窗口内容是"offset 超界"提示文案（与 Sandbox 适配器的 selectLineRange 渲染一致）
        return successResult(selection.content, {
          summary: `offset ${offset} 超出文件总行数 ${selection.totalLines}`,
          outputType: "text",
          metadata: this.readMetadata(resolvedPath, stat.size, selection, context, agent),
          toolName,
        });
      }

      let summary = `文件读取成功: ${input.filePath}（行 ${selection.startLine}-${selection.endLine}，共 ${selection.totalLines} 行，${stat.size} 字节）`;
      if (selection.hasMore) {
        summary += `；还有后续内容，可继续调用 read_file(offset=${selection.nextOffset})`;
      } else {
        summary += "；已到文件末尾";
      }
      if (selection.charTruncated) {
        summary += `；本次受单次 ${READ_FILE_CHAR_BUDGET} 字符预算限制提前截断`;
      }
      if (selection.truncatedLines > 0) {
        summary += `；${selection.truncatedLines} 行超长，已各截断至前 ${READ_FILE_MAX_LINE_CHARS} 字符`;
      }

      return successResult(selection.content, {
        summary,
        outputType: "text",
        metadata: this.readMetadata(resolvedPath, stat.size, selection, context, agent),
        toolName,
      });
    } catch (error) {
      return errorResult(`读取文件失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  private readMetadata(
    resolvedPath: string,
    fileSize: number,
    selection: ReturnType<typeof selectLineRange>,
    context: ToolExecContext,
    agent: AgentConfig,
  ): Record<string, unknown> {
    return {
      execution_paths: this.pathManager.executionPaths(context, agent.custom_params),
      file_path: resolvedPath,
      display_path: this.pathManager.toDisplayPath(resolvedPath),
      file_size: fileSize,
      total_lines: selection.totalLines,
      start_line: selection.startLine,
      end_line: selection.endLine,
      has_more: selection.hasMore,
      next_offset: selection.nextOffset,
      char_truncated: selection.charTruncated,
      truncated_lines: selection.truncatedLines,
    };
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
          outputType: "json",
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
        return errorResult(`文件不存在: ${input.filePath}${suggestNearbyFiles(resolvedPath)}`, toolName);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return errorResult(`路径不是文件: ${input.filePath}`, toolName);
      }
      if (!input.oldString) {
        return errorResult("old_string 不能为空", toolName);
      }

      const encoding = normalizeEncoding(input.encoding);
      const rawContent = fs.readFileSync(resolvedPath).toString(encoding);
      // 匹配/替换在 LF 归一文本上做（CRLF 文件与 LF old_string 互相可匹配，dsh 同款）；
      // 写回时按文件原行尾风格还原，混合行尾文件按 LF 归一写。
      const wasCrlf = crlfDominant(rawContent);
      const originalContent = normalizeLineEndings(rawContent);
      const oldString = normalizeLineEndings(input.oldString);
      const newString = normalizeLineEndings(input.newString);
      const matchLines = findMatchLineNumbers(originalContent, oldString);
      if (matchLines.length === 0) {
        return errorResult("未找到匹配内容，请检查 old_string 是否与文件内容完全一致（含空白与换行）", toolName);
      }
      if (matchLines.length > 1 && !input.replaceAll) {
        return errorResult(
          `匹配不唯一（找到 ${matchLines.length} 处，位于第 ${matchLines.join(", ")} 行）。请扩大 old_string 上下文使其唯一，或设 replace_all=true`,
          toolName,
        );
      }

      const updatedContent = input.replaceAll
        ? originalContent.split(oldString).join(newString)
        : originalContent.replace(oldString, newString);
      await this.fileHistory?.trackEdit(context.sessionId, resolvedPath);
      fs.writeFileSync(resolvedPath, wasCrlf ? restoreCrlf(updatedContent) : updatedContent, { encoding });
      const updatedStat = fs.statSync(resolvedPath);
      const diffPreview = buildDiffPreview(originalContent, updatedContent, path.basename(resolvedPath));
      const displayPath = this.pathManager.toDisplayPath(resolvedPath);
      const replacements = input.replaceAll ? matchLines.length : 1;
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
    outputType: import("@ragsystem/agent-sdk").ToolOutputType;
    metadata: Record<string, unknown>;
    toolName: string;
  },
): ToolExecutionResult {
  return toolSuccess(content, input);
}

function errorResult(message: string, toolName: string): ToolExecutionResult {
  return toolError(toolName, message);
}

/** 路径笔误时的就近提示：在同目录文件里按名称相似度给出候选，避免只报"文件不存在"。 */
function suggestNearbyFiles(resolvedPath: string, limit = 3): string {
  const target = path.basename(resolvedPath).toLowerCase();
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(resolvedPath), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase() !== target)
      .map((entry) => entry.name);
  } catch {
    return "";
  }
  const scored = names
    .map((name) => ({ name, score: 1 - levenshtein(target, name.toLowerCase()) / Math.max(target.length, name.length) }))
    .filter((item) => item.score >= 0.4)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  return scored.length ? `；最接近的候选: ${scored.map((item) => item.name).join(", ")}` : "";
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  const cols = right.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i <= left.length; i++) {
    const current = new Array<number>(cols);
    current[0] = i;
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left.charCodeAt(i - 1) === right.charCodeAt(j - 1) ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[cols - 1]!;
}
