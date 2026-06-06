import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolExecutionResult } from "./memory-tool-service.js";
import type { RuntimeToolExecutionContext } from "./runtime-tool-types.js";
import {
  buildDataStructurePreview,
  DEFAULT_STRUCTURE_PREVIEW_DEPTH,
  DEFAULT_STRUCTURE_PREVIEW_FIELDS,
  DEFAULT_STRUCTURE_PREVIEW_ROWS,
  readPreviewLimit,
} from "./local-document-tool-service/preview.js";

const DEFAULT_READ_MAX_LINES = 2000;
const DISPLAY_PATH_PREFIX = "./data/";

type ManagedOperation = "read" | "write" | "edit";
type ManagedSpace = "workspace" | "transient" | "exports";

export class LocalDocumentToolService {
  private readonly dataRoot: string;

  constructor(options: { dataRoot?: string | undefined } = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  }

  readFile(
    input: {
      filePath: string;
      encoding?: string | null;
      offset?: number | null;
      limit?: number | null;
      filePathSpace?: string | null;
    },
    context: RuntimeToolExecutionContext,
  ): ToolExecutionResult<string> {
    const toolName = "read_file";
    try {
      const resolvedPath = this.resolveManagedPath(input.filePath, {
        context,
        operation: "read",
        explicitSpace: input.filePathSpace ?? null,
      });
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
            display_path: this.toDisplayPath(resolvedPath),
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
          display_path: this.toDisplayPath(resolvedPath),
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
    context: RuntimeToolExecutionContext,
  ): ToolExecutionResult {
    const toolName = "write_file";
    try {
      const mode = normalizeString(input.mode)?.toLowerCase() === "json" ? "json" : "text";
      const resolvedPath = this.resolveManagedPath(input.filePath ?? null, {
        context,
        operation: "write",
        explicitSpace: input.filePathSpace ?? null,
        suffix: mode === "json" ? ".json" : ".txt",
      });
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      const encoding = normalizeEncoding(input.encoding);
      fs.writeFileSync(resolvedPath, renderWritableContent(input.content, mode), { encoding });
      const stat = fs.statSync(resolvedPath);
      const displayPath = this.toDisplayPath(resolvedPath);
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
    context: RuntimeToolExecutionContext,
  ): ToolExecutionResult {
    const toolName = "edit_file";
    try {
      const resolvedPath = this.resolveManagedPath(input.filePath, {
        context,
        operation: "edit",
        explicitSpace: input.filePathSpace ?? null,
      });
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
      fs.writeFileSync(resolvedPath, updatedContent, { encoding });
      const updatedStat = fs.statSync(resolvedPath);
      const diffPreview = buildDiffPreview(originalContent, updatedContent, path.basename(resolvedPath));
      const displayPath = this.toDisplayPath(resolvedPath);
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
    context: RuntimeToolExecutionContext,
  ): ToolExecutionResult {
    const toolName = "preview_data_structure";
    try {
      const resolvedPath = this.resolveManagedPath(input.filePath, {
        context,
        operation: "read",
        explicitSpace: input.filePathSpace ?? null,
      });
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

  getExternalPathApprovalCandidates(
    toolName: string,
    args: Record<string, unknown> | undefined,
    context: RuntimeToolExecutionContext,
  ): string[] {
    const operation = documentOperationForTool(toolName);
    if (!operation) {
      return [];
    }
    const rawPath = normalizeString(args?.file_path) ?? normalizeString(args?.filePath);
    if (!rawPath || rawPath.startsWith(DISPLAY_PATH_PREFIX) || !isAbsolutePathLike(rawPath)) {
      return [];
    }

    const sessionId = normalizeString(context.sessionId);
    const runId = normalizeString(context.runId);
    const workspaceRoot = normalizeString(context.workspaceRoot) ??
      normalizeString(asRecord(context.agent?.custom_params)?.workspace_root);
    const candidatePath = resolvePathLike(rawPath);
    try {
      this.assertAllowedPath(candidatePath, {
        sessionId,
        runId,
        operation,
        workspaceRoot,
        originalPath: rawPath,
        approvedExternalPaths: [],
      });
      return [];
    } catch {
      return [candidatePath];
    }
  }

  private resolveManagedPath(
    filePath: string | null,
    input: {
      context: RuntimeToolExecutionContext;
      operation: ManagedOperation;
      explicitSpace?: string | null;
      suffix?: string | undefined;
    },
  ): string {
    const rawPath = String(filePath ?? "").trim();
    if (!rawPath && input.operation === "read") {
      throw new Error("读取操作必须提供 file_path");
    }

    const sessionId = normalizeString(input.context.sessionId);
    const runId = normalizeString(input.context.runId);
    const workspaceRoot = normalizeString(input.context.workspaceRoot) ??
      normalizeString(asRecord(input.context.agent?.custom_params)?.workspace_root);
    const explicitSpace = normalizeManagedSpace(input.explicitSpace);
    const defaultOutputSpace = normalizeManagedSpace(asRecord(input.context.agent?.custom_params)?.default_output_space) ?? null;
    const approvedExternalPaths = input.context.approvedExternalPaths ?? [];

    if (!rawPath) {
      const root = this.allocateOutputRoot({
        sessionId,
        runId,
        workspaceRoot,
        explicitSpace,
        defaultOutputSpace,
      });
      fs.mkdirSync(root, { recursive: true });
      return path.join(root, `output_${randomSuffix()}${input.suffix ?? ".txt"}`);
    }

    const displayMapped = this.fromDisplayPath(rawPath);
    if (displayMapped) {
      return this.assertAllowedPath(displayMapped, {
        sessionId,
        runId,
        operation: input.operation,
        workspaceRoot,
        originalPath: rawPath,
        approvedExternalPaths,
      });
    }

    if (isAbsolutePathLike(rawPath)) {
      return this.assertAllowedPath(resolvePathLike(rawPath), {
        sessionId,
        runId,
        operation: input.operation,
        workspaceRoot,
        originalPath: rawPath,
        approvedExternalPaths,
      });
    }

    if (explicitSpace) {
      const candidate = path.resolve(this.managedSpaceRoot(explicitSpace, { sessionId, runId, workspaceRoot }), rawPath);
      return this.assertAllowedPath(candidate, {
        sessionId,
        runId,
        operation: input.operation,
        workspaceRoot,
        originalPath: rawPath,
        approvedExternalPaths,
      });
    }

    const candidateRoots = this.relativeCandidateRoots({ sessionId, runId, operation: input.operation, workspaceRoot });
    if (!candidateRoots.length) {
      throw new Error(`路径 '${rawPath}' 缺少可用的受管根目录`);
    }
    if (input.operation === "read") {
      for (const root of candidateRoots) {
        const candidate = path.resolve(root, rawPath);
        if (isPathUnder(candidate, root) && fs.existsSync(candidate)) {
          return this.assertAllowedPath(candidate, {
            sessionId,
            runId,
            operation: input.operation,
            workspaceRoot,
            originalPath: rawPath,
            approvedExternalPaths,
          });
        }
      }
    }

    return this.assertAllowedPath(path.resolve(candidateRoots[0]!, rawPath), {
      sessionId,
      runId,
      operation: input.operation,
      workspaceRoot,
      originalPath: rawPath,
      approvedExternalPaths,
    });
  }

  private assertAllowedPath(
    candidatePath: string,
    input: {
      sessionId: string | null;
      runId: string | null;
      operation: ManagedOperation;
      workspaceRoot: string | null;
      originalPath: string;
      approvedExternalPaths?: string[] | undefined;
    },
  ): string {
    const resolvedPath = path.resolve(candidatePath);
    const allowedRoots = this.allowedRoots({
      sessionId: input.sessionId,
      runId: input.runId,
      operation: input.operation,
      workspaceRoot: input.workspaceRoot,
      approvedExternalPaths: input.approvedExternalPaths,
    });
    if (allowedRoots.some((root) => isPathUnder(resolvedPath, root))) {
      return resolvedPath;
    }
    throw new Error(`路径 '${input.originalPath}' 超出允许的受管目录范围，禁止访问`);
  }

  private relativeCandidateRoots(input: {
    sessionId: string | null;
    runId: string | null;
    operation: ManagedOperation;
    workspaceRoot: string | null;
    approvedExternalPaths?: string[] | undefined;
  }): string[] {
    if (input.operation === "read") {
      return dedupePaths([
        this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
        ...this.sessionReadRoots(input.sessionId, input.runId, input.workspaceRoot),
        this.dataRoot,
        ...(input.approvedExternalPaths ?? []),
      ]);
    }
    return dedupePaths([
      this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
      input.sessionId ? path.join(this.dataRoot, "sessions", input.sessionId, "transient") : null,
      input.sessionId && input.runId
        ? path.join(this.dataRoot, "sessions", input.sessionId, "exports", input.runId)
        : input.sessionId
          ? path.join(this.dataRoot, "sessions", input.sessionId, "exports")
          : null,
      ...(input.approvedExternalPaths ?? []),
    ]);
  }

  private allowedRoots(input: {
    sessionId: string | null;
    runId: string | null;
    operation: ManagedOperation;
    workspaceRoot: string | null;
    approvedExternalPaths?: string[] | undefined;
  }): string[] {
    if (input.operation === "read") {
      return dedupePaths([
        this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
        ...this.sessionReadRoots(input.sessionId, input.runId, input.workspaceRoot),
        this.dataRoot,
        ...(input.approvedExternalPaths ?? []),
      ]);
    }
    return dedupePaths([
      this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
      input.sessionId ? path.join(this.dataRoot, "sessions", input.sessionId, "transient") : null,
      input.sessionId && input.runId
        ? path.join(this.dataRoot, "sessions", input.sessionId, "exports", input.runId)
        : input.sessionId
          ? path.join(this.dataRoot, "sessions", input.sessionId, "exports")
          : null,
      ...(input.approvedExternalPaths ?? []),
    ]);
  }

  private sessionReadRoots(sessionId: string | null, runId: string | null, workspaceRoot: string | null): string[] {
    if (!sessionId) {
      return [];
    }
    const sessionRoot = path.join(this.dataRoot, "sessions", sessionId);
    return dedupePaths([
      path.join(sessionRoot, "sandbox"),
      this.effectiveWorkspaceRoot(sessionId, workspaceRoot),
      path.join(sessionRoot, "transient"),
      path.join(sessionRoot, "uploads"),
      path.join(sessionRoot, "visualizations"),
      runId ? path.join(sessionRoot, "exports", runId) : null,
      path.join(sessionRoot, "exports"),
      sessionRoot,
    ]);
  }

  private managedSpaceRoot(
    space: ManagedSpace,
    input: { sessionId: string | null; runId: string | null; workspaceRoot: string | null },
  ): string {
    if (space === "workspace") {
      const root = this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot);
      if (!root) {
        throw new Error("workspace 路径缺少可用目录");
      }
      return root;
    }
    if (!input.sessionId) {
      throw new Error(`${space} 路径缺少 session_id`);
    }
    if (space === "transient") {
      return path.join(this.dataRoot, "sessions", input.sessionId, "transient");
    }
    if (!input.runId) {
      throw new Error("exports 路径缺少 run_id");
    }
    return path.join(this.dataRoot, "sessions", input.sessionId, "exports", input.runId);
  }

  private allocateOutputRoot(input: {
    sessionId: string | null;
    runId: string | null;
    workspaceRoot: string | null;
    explicitSpace: ManagedSpace | null;
    defaultOutputSpace: ManagedSpace | null;
  }): string {
    const space = input.explicitSpace ?? input.defaultOutputSpace ?? "transient";
    if (space === "workspace") {
      const root = this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot);
      if (!root) {
        throw new Error("workspace 输出缺少可用目录");
      }
      return root;
    }
    if (!input.sessionId) {
      return path.join(this.dataRoot, "sessions", "anonymous", "transient");
    }
    if (space === "exports") {
      if (!input.runId) {
        throw new Error("exports 输出缺少 run_id");
      }
      return path.join(this.dataRoot, "sessions", input.sessionId, "exports", input.runId);
    }
    return path.join(this.dataRoot, "sessions", input.sessionId, "transient");
  }

  private effectiveWorkspaceRoot(sessionId: string | null, workspaceRoot: string | null): string | null {
    if (workspaceRoot) {
      return path.resolve(workspaceRoot);
    }
    return sessionId ? path.join(this.dataRoot, "sessions", sessionId, "workspace") : null;
  }

  private fromDisplayPath(filePath: string): string | null {
    if (!filePath.startsWith(DISPLAY_PATH_PREFIX)) {
      return null;
    }
    return path.join(this.dataRoot, filePath.slice(DISPLAY_PATH_PREFIX.length));
  }

  private toDisplayPath(filePath: string): string {
    const resolved = path.resolve(filePath);
    const relative = path.relative(this.dataRoot, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return `${DISPLAY_PATH_PREFIX}${relative.split(path.sep).join("/")}`;
    }
    return resolved;
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
): ToolExecutionResult<T> {
  return {
    success: true,
    tool_name: input.toolName,
    summary: input.summary,
    answer: null,
    output_type: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llm_hint: null,
  };
}

function errorResult(message: string, toolName: string): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
    },
    artifacts: [],
    llm_hint: null,
  };
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

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}

function normalizeManagedSpace(value: unknown): ManagedSpace | null {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "workspace" || normalized === "transient" || normalized === "exports") {
    return normalized;
  }
  if (normalized) {
    throw new Error(`不支持的显式空间: ${value}`);
  }
  return null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function documentOperationForTool(toolName: string): ManagedOperation | null {
  if (toolName === "read_file") {
    return "read";
  }
  if (toolName === "write_file") {
    return "write";
  }
  if (toolName === "edit_file") {
    return "edit";
  }
  return null;
}

function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function resolvePathLike(value: string): string {
  if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(value)) {
    return value.replace(/\//g, "\\");
  }
  return path.resolve(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function dedupePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    if (!item) {
      continue;
    }
    const resolved = path.resolve(item);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
