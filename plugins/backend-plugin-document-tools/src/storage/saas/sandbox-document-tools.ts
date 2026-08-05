import { randomUUID } from "node:crypto";
import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { SandboxLeaseRuntime } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import { resolveSandboxPath } from "@ragsystem/backend-core/contracts/sandbox/sandbox-paths.js";

const DEFAULT_READ_LINES = 2_000;
const MAX_TOOL_FILE_BYTES = 16 * 1024 * 1024;

export class SaaSDocumentToolService {
  constructor(private readonly leases: SandboxLeaseRuntime) {}

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
