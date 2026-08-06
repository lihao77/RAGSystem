import { randomUUID } from "node:crypto";
import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { SandboxLeaseRuntime } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import { resolveSandboxPath } from "@ragsystem/backend-core/contracts/sandbox/sandbox-paths.js";
import {
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
  constructor(private readonly leases: SandboxLeaseRuntime) {}

  async readFile(input: ReadFileInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "read_file";
    try {
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "read" });
      const range = normalizeReadRange(input.offset, input.limit);
      const result = await this.leases.withLease(context, (lease, provider) => provider.readFile(lease, {
        path: file.internalPath,
        encoding: normalizeEncoding(input.encoding),
        maxBytes: MAX_TOOL_FILE_BYTES,
        signal: context.signal,
      }));
      const selection = selectLineRange(result.content, range.offset, range.limit);
      return toolSuccess(selection.content, {
        toolName,
        summary: selection.hasMore
          ? `文件读取成功: ${file.displayPath}；还有后续内容，可继续调用 read_file(offset=${selection.nextOffset})`
          : `文件读取成功: ${file.displayPath}`,
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

  async editFile(input: EditFileInput, context: ToolExecContext): Promise<ToolExecutionResult> {
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

  async previewDataStructure(input: PreviewDataStructureInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "preview_data_structure";
    try {
      const file = resolveSandboxPath(input.filePath, { explicitSpace: input.filePathSpace, operation: "read" });
      const maxPreviewRows = normalizePreviewLimit(input.maxPreviewRows, 5, "max_preview_rows");
      const maxDepth = normalizePreviewLimit(input.maxDepth, 3, "max_depth");
      const maxFields = normalizePreviewLimit(input.maxFields, 20, "max_fields");
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

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
