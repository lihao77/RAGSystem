import { randomUUID } from "node:crypto";
import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { RunSandboxRuntime } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import { resolveSandboxPath } from "@ragsystem/backend-core/contracts/sandbox/sandbox-paths.js";
import {
  READ_FILE_CHAR_BUDGET,
  READ_FILE_MAX_LINE_CHARS,
  isTextualEncoding,
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
} from "../../tools/shared/document-policy.js";

const MAX_TOOL_FILE_BYTES = 16 * 1024 * 1024;

export class SaaSDocumentToolService {
  constructor(private readonly sandbox: RunSandboxRuntime) {}

  async readFile(input: ReadFileInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "read_file";
    try {
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "read" });
      const range = normalizeReadRange(input.offset, input.limit);
      const encoding = normalizeEncoding(input.encoding);
      const result = await this.sandbox.readFile(context, {
        path: file.internalPath,
        encoding,
        maxBytes: MAX_TOOL_FILE_BYTES,
      });
      // base64/hex 无行语义：与本地适配器一致整读原样返回（仅字符预算截断），不做行号化渲染。
      if (!isTextualEncoding(encoding)) {
        const truncated = result.content.length > READ_FILE_CHAR_BUDGET;
        const content = truncated ? result.content.slice(0, READ_FILE_CHAR_BUDGET) : result.content;
        return toolSuccess(content, {
          toolName,
          summary: `文件读取成功: ${file.displayPath}（${result.size} 字节，${encoding} 编码；二进制类编码无行语义，offset 不适用）${truncated ? `；已截断至前 ${READ_FILE_CHAR_BUDGET} 字符` : ""}`,
          outputType: "text",
          metadata: {
            file_path: file.displayPath,
            display_path: file.displayPath,
            file_size: result.size,
            total_lines: 1,
            start_line: 1,
            end_line: 1,
            has_more: false,
            next_offset: null,
            char_truncated: truncated,
            truncated_lines: 0,
          },
        });
      }
      const selection = selectLineRange(result.content, range.offset, range.limit);
      let summary = `文件读取成功: ${file.displayPath}`;
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
      return toolSuccess(selection.content, {
        toolName,
        summary,
        outputType: "text",
        metadata: {
          file_path: file.displayPath,
          display_path: file.displayPath,
          file_size: result.size,
          total_lines: selection.totalLines,
          start_line: selection.startLine,
          end_line: selection.endLine,
          has_more: selection.hasMore,
          next_offset: selection.nextOffset,
          char_truncated: selection.charTruncated,
          truncated_lines: selection.truncatedLines,
        },
      });
    } catch (error) {
      return toolError(toolName, `读取文件失败: ${messageOf(error)}`);
    }
  }

  async writeFile(input: WriteFileInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "write_file";
    try {
      const mode = normalizeWriteMode(input.mode);
      const defaultName = `generated-${randomUUID()}${mode === "json" ? ".json" : ".txt"}`;
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "write", defaultName });
      const content = renderWritableContent(input.content, mode);
      const result = await this.sandbox.writeFile(context, {
        path: file.internalPath,
        content,
        encoding: normalizeEncoding(input.encoding),
      });
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

  async editFile(input: EditFileInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "edit_file";
    try {
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "write" });
      if (!input.oldString) return toolError(toolName, "old_string 不能为空");
      const result = await this.sandbox.editFile(context, {
        path: file.internalPath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll === true,
        encoding: normalizeEncoding(input.encoding),
      });
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

  async previewDataStructure(input: PreviewDataStructureInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "preview_data_structure";
    try {
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "read" });
      const maxPreviewRows = normalizePreviewLimit(input.maxPreviewRows, 5, "max_preview_rows");
      const maxDepth = normalizePreviewLimit(input.maxDepth, 3, "max_depth");
      const maxFields = normalizePreviewLimit(input.maxFields, 20, "max_fields");
      const result = await this.sandbox.previewFile(context, {
        path: file.internalPath,
        encoding: normalizeEncoding(input.encoding),
        maxBytes: MAX_TOOL_FILE_BYTES,
        maxPreviewRows,
        maxDepth,
        maxFields,
      });
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

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
