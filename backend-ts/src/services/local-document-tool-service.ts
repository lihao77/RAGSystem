import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { ToolExecutionResult } from "./memory-tool-service.js";
import type { RuntimeToolExecutionContext } from "./runtime-tool-types.js";

const DEFAULT_READ_MAX_LINES = 2000;
const DISPLAY_PATH_PREFIX = "./data/";
const DEFAULT_STRUCTURE_PREVIEW_ROWS = 5;
const DEFAULT_STRUCTURE_PREVIEW_DEPTH = 3;
const DEFAULT_STRUCTURE_PREVIEW_FIELDS = 20;
const WKT_PATTERN = /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*\(/i;
const GEOJSON_TYPES = new Set([
  "FeatureCollection",
  "Feature",
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

type ManagedOperation = "read" | "write" | "edit";
type ManagedSpace = "workspace" | "transient" | "exports";
type PreviewRecord = Record<string, unknown>;

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

      const encoding = normalizeEncoding(input.encoding);
      const suffix = path.extname(resolvedPath).toLowerCase();
      let fileType: string;
      let structure: PreviewRecord;

      if (suffix === ".json" || suffix === ".yaml" || suffix === ".yml") {
        const data = loadStructuredDocument(resolvedPath, encoding);
        structure = previewDataValue(data, {
          maxDepth: maxDepth.value,
          maxFields: maxFields.value,
          sampleSize: maxPreviewRows.value,
        });
        fileType = suffix.slice(1);
      } else if (suffix === ".csv" || suffix === ".tsv") {
        const delimiter = suffix === ".tsv" ? "\t" : detectCsvDelimiter(resolvedPath, encoding, ",");
        structure = previewDelimitedFile(resolvedPath, {
          encoding,
          delimiter,
          maxRows: maxPreviewRows.value,
        });
        fileType = delimiter === "\t" ? "tsv" : "csv";
      } else {
        structure = previewTextFile(resolvedPath, {
          encoding,
          maxRows: maxPreviewRows.value,
        });
        fileType = suffix ? suffix.slice(1) : "text";
      }

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
      });
    }

    if (path.isAbsolute(rawPath)) {
      return this.assertAllowedPath(rawPath, {
        sessionId,
        runId,
        operation: input.operation,
        workspaceRoot,
        originalPath: rawPath,
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
    },
  ): string {
    const resolvedPath = path.resolve(candidatePath);
    const allowedRoots = this.allowedRoots({
      sessionId: input.sessionId,
      runId: input.runId,
      operation: input.operation,
      workspaceRoot: input.workspaceRoot,
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
  }): string[] {
    if (input.operation === "read") {
      return dedupePaths([
        this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
        ...this.sessionReadRoots(input.sessionId, input.runId, input.workspaceRoot),
        this.dataRoot,
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
    ]);
  }

  private allowedRoots(input: {
    sessionId: string | null;
    runId: string | null;
    operation: ManagedOperation;
    workspaceRoot: string | null;
  }): string[] {
    if (input.operation === "read") {
      return dedupePaths([
        this.effectiveWorkspaceRoot(input.sessionId, input.workspaceRoot),
        ...this.sessionReadRoots(input.sessionId, input.runId, input.workspaceRoot),
        this.dataRoot,
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

function readPreviewLimit(
  value: number | null | undefined,
  fallback: number,
  label: "max_preview_rows" | "max_depth" | "max_fields",
): { value: number } | { error: string } {
  if (value === null || value === undefined) {
    return { value: fallback };
  }
  if (!Number.isInteger(value) || value < 1) {
    return { error: `${label} 必须 >= 1` };
  }
  return { value };
}

function loadStructuredDocument(filePath: string, encoding: BufferEncoding): unknown {
  const content = fs.readFileSync(filePath).toString(encoding);
  const suffix = path.extname(filePath).toLowerCase();
  if (suffix === ".json") {
    return JSON.parse(content);
  }
  if (suffix === ".yaml" || suffix === ".yml") {
    return parseYaml(content) ?? null;
  }
  throw new Error(`不支持的结构化文档格式: ${suffix}`);
}

function previewDataValue(
  value: unknown,
  input: {
    depth?: number;
    maxDepth: number;
    maxFields: number;
    sampleSize: number;
  },
): PreviewRecord {
  const depth = input.depth ?? 0;
  if (isRecord(value) && isGeoJson(value)) {
    return previewGeoJson(value, input.sampleSize);
  }

  if (depth >= input.maxDepth) {
    if (isRecord(value)) {
      return {
        type: "object",
        key_count: Object.keys(value).length,
        truncated: true,
      };
    }
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        truncated: true,
      };
    }
    return previewScalar(value);
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    const fields: Record<string, PreviewRecord> = {};
    for (const key of keys.slice(0, input.maxFields)) {
      fields[key] = previewDataValue(value[key], {
        ...input,
        depth: depth + 1,
      });
    }
    const result: PreviewRecord = {
      type: "object",
      key_count: keys.length,
      keys: keys.slice(0, input.maxFields),
      fields,
    };
    if (keys.length > input.maxFields) {
      result.truncated_keys = keys.length - input.maxFields;
    }
    return result;
  }

  if (Array.isArray(value)) {
    const sampleItems = value.slice(0, input.sampleSize);
    const itemTypes = [...new Set(sampleItems.map((item) => arrayItemTypeName(item)))].sort();
    const result: PreviewRecord = {
      type: "array",
      length: value.length,
      item_types: itemTypes,
      sample_item_count: sampleItems.length,
    };

    if (!sampleItems.length) {
      return result;
    }

    if (sampleItems.every(isRecord)) {
      const summaries = new Map<string, { types: Set<string>; presentIn: number; example: unknown }>();
      const fieldOrder: string[] = [];
      for (const item of sampleItems) {
        for (const [rawKey, itemValue] of Object.entries(item)) {
          const key = String(rawKey);
          if (!summaries.has(key)) {
            if (fieldOrder.length >= input.maxFields) {
              continue;
            }
            fieldOrder.push(key);
            summaries.set(key, {
              types: new Set<string>(),
              presentIn: 0,
              example: undefined,
            });
          }
          const summary = summaries.get(key);
          if (!summary) {
            continue;
          }
          summary.types.add(fieldTypeName(itemValue));
          summary.presentIn += 1;
          if (summary.example === undefined) {
            summary.example = previewFieldExample(itemValue, {
              ...input,
              depth: depth + 1,
            });
          }
        }
      }

      const fields: Record<string, PreviewRecord> = {};
      for (const [key, summary] of summaries.entries()) {
        fields[key] = {
          types: [...summary.types].sort(),
          present_in_sample: summary.presentIn,
          example: summary.example,
        };
      }
      const itemStructure: PreviewRecord = {
        type: "object",
        fields,
      };
      if (fieldOrder.length >= input.maxFields) {
        itemStructure.truncated_fields = true;
      }
      result.item_structure = itemStructure;
      return result;
    }

    result.sample_items = sampleItems.map((item) =>
      previewDataValue(item, {
        ...input,
        depth: depth + 1,
      }),
    );
    return result;
  }

  return previewScalar(value);
}

function previewFieldExample(
  value: unknown,
  input: {
    depth: number;
    maxDepth: number;
    maxFields: number;
    sampleSize: number;
  },
): unknown {
  if (isRecord(value) && isGeoJson(value)) {
    return previewGeoJson(value, input.sampleSize);
  }
  if (isRecord(value) || Array.isArray(value)) {
    return previewDataValue(value, input);
  }
  const scalar = previewScalar(value);
  return scalar.type === "wkt_geometry" ? scalar : scalar.example ?? value;
}

function previewDelimitedFile(
  filePath: string,
  input: {
    encoding: BufferEncoding;
    delimiter: string;
    maxRows: number;
  },
): PreviewRecord {
  const content = fs.readFileSync(filePath).toString(input.encoding);
  const lines = splitTextLines(content);
  const fieldnames = lines.length ? parseDelimitedLine(lines[0]!, input.delimiter) : [];
  const sampleRows: Array<Record<string, string>> = [];
  let totalRows = 0;

  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue;
    }
    const values = parseDelimitedLine(line, input.delimiter);
    totalRows += 1;
    if (sampleRows.length < input.maxRows) {
      const row: Record<string, string> = {};
      for (const [index, field] of fieldnames.entries()) {
        row[field] = values[index] ?? "";
      }
      sampleRows.push(row);
    }
  }

  return {
    root_type: "table",
    delimiter: input.delimiter,
    column_count: fieldnames.length,
    columns: fieldnames,
    sample_row_count: sampleRows.length,
    total_rows: totalRows,
    column_types: inferCsvColumnTypes(sampleRows, fieldnames),
    sample_rows: sampleRows,
  };
}

function previewTextFile(
  filePath: string,
  input: {
    encoding: BufferEncoding;
    maxRows: number;
  },
): PreviewRecord {
  const content = fs.readFileSync(filePath).toString(input.encoding);
  const lines = splitTextLines(content);
  const lineLengths = lines.map((line) => line.length);
  const totalLength = lineLengths.reduce((sum, value) => sum + value, 0);
  return {
    root_type: "text",
    total_lines: lines.length,
    non_empty_lines: lines.filter((line) => line.trim()).length,
    max_line_length: Math.max(0, ...lineLengths),
    average_line_length: lines.length ? Math.round((totalLength / lines.length) * 100) / 100 : 0,
    preview_lines: lines.slice(0, input.maxRows),
  };
}

function detectCsvDelimiter(filePath: string, encoding: BufferEncoding, fallback: string): string {
  const sample = fs.readFileSync(filePath).toString(encoding).slice(0, 2048);
  if (!sample.trim()) {
    return fallback;
  }
  const lines = splitTextLines(sample).filter((line) => line.trim()).slice(0, 5);
  const candidates = [",", "\t", ";", "|"];
  let bestDelimiter = fallback;
  let bestScore = 0;
  for (const delimiter of candidates) {
    const counts = lines.map((line) => countDelimiterOutsideQuotes(line, delimiter));
    const positiveCounts = counts.filter((count) => count > 0);
    if (!positiveCounts.length) {
      continue;
    }
    const first = positiveCounts[0]!;
    const consistency = positiveCounts.filter((count) => count === first).length;
    const score = consistency * 100 + positiveCounts.reduce((sum, count) => sum + count, 0);
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }
  return bestDelimiter;
}

function inferCsvColumnTypes(
  sampleRows: Array<Record<string, string>>,
  fieldnames: string[],
): Record<string, PreviewRecord> {
  const result: Record<string, PreviewRecord> = {};
  for (const field of fieldnames) {
    const observedTypes = new Set<string>();
    const examples: string[] = [];
    let nonEmptyCount = 0;
    for (const row of sampleRows) {
      const rawValue = (row[field] ?? "").trim();
      if (!rawValue) {
        continue;
      }
      nonEmptyCount += 1;
      if (examples.length < 2) {
        examples.push(truncatePreviewText(rawValue));
      }
      observedTypes.add(inferCsvScalarType(rawValue));
    }
    result[field] = {
      types: observedTypes.size ? [...observedTypes].sort() : ["string"],
      non_empty_in_sample: nonEmptyCount,
      examples,
    };
  }
  return result;
}

function inferCsvScalarType(value: string): string {
  const lowered = value.toLowerCase();
  if (lowered === "true" || lowered === "false") {
    return "boolean";
  }
  if (/^[+-]?\d+$/.test(value)) {
    return "integer";
  }
  if (value.trim() !== "" && Number.isFinite(Number(value))) {
    return "number";
  }
  return "string";
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function countDelimiterOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      count += 1;
    }
  }
  return count;
}

function splitTextLines(content: string): string[] {
  if (!content) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function isRecord(value: unknown): value is PreviewRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGeoJson(value: PreviewRecord): boolean {
  const type = typeof value.type === "string" ? value.type : null;
  return Boolean(type && GEOJSON_TYPES.has(type));
}

function previewGeoJson(value: PreviewRecord, sampleSize = 3): PreviewRecord {
  const geojsonType = typeof value.type === "string" ? value.type : "";
  if (geojsonType === "FeatureCollection") {
    const features = Array.isArray(value.features) ? value.features.filter(isRecord) : [];
    const geometryTypes: Record<string, number> = {};
    let totalCoordinates = 0;
    let mergedBbox: number[] | null = null;
    for (const feature of features) {
      const geometry = isRecord(feature.geometry) ? feature.geometry : {};
      const geometryType = typeof geometry.type === "string" ? geometry.type : "null";
      geometryTypes[geometryType] = (geometryTypes[geometryType] ?? 0) + 1;
      totalCoordinates += countCoordinates(geometry.coordinates);
      const bbox = bboxFromCoordinates(geometry.coordinates);
      if (bbox) {
        mergedBbox = mergeBbox(mergedBbox, bbox);
      }
    }

    const propertiesFields: string[] = [];
    const sampleProperties: PreviewRecord[] = [];
    for (const feature of features.slice(0, sampleSize)) {
      const properties = isRecord(feature.properties) ? feature.properties : {};
      if (!propertiesFields.length) {
        propertiesFields.push(...Object.keys(properties).slice(0, DEFAULT_STRUCTURE_PREVIEW_FIELDS));
      }
      const sampled: PreviewRecord = {};
      for (const [key, propertyValue] of Object.entries(properties).slice(0, 8)) {
        if (isRecord(propertyValue) || Array.isArray(propertyValue)) {
          continue;
        }
        if (typeof propertyValue === "string" && propertyValue.length > 60) {
          sampled[key] = isWktGeometry(propertyValue) ? previewWkt(propertyValue) : truncatePreviewText(propertyValue, 80);
        } else {
          sampled[key] = propertyValue;
        }
      }
      sampleProperties.push(sampled);
    }

    const result: PreviewRecord = {
      type: "geojson",
      geojson_type: "FeatureCollection",
      feature_count: features.length,
      geometry_types: geometryTypes,
      total_coordinates_estimate: totalCoordinates,
      properties_fields: propertiesFields,
    };
    const bbox = normalizeBbox(value.bbox) ?? mergedBbox;
    if (bbox) {
      result.bbox = bbox.map(roundCoordinate);
    }
    if (sampleProperties.length) {
      result.sample_properties = sampleProperties;
    }
    return result;
  }

  if (geojsonType === "Feature") {
    const geometry = isRecord(value.geometry) ? value.geometry : {};
    const properties = isRecord(value.properties) ? value.properties : {};
    return {
      type: "geojson",
      geojson_type: "Feature",
      ...previewGeometry(geometry),
      properties_fields: Object.keys(properties).slice(0, DEFAULT_STRUCTURE_PREVIEW_FIELDS),
    };
  }

  return {
    type: "geojson",
    ...previewGeometry(value),
  };
}

function previewGeometry(geometry: PreviewRecord): PreviewRecord {
  const result: PreviewRecord = {
    geometry_type: typeof geometry.type === "string" ? geometry.type : "unknown",
    coordinate_count: countCoordinates(geometry.coordinates),
  };
  const bbox = normalizeBbox(geometry.bbox) ?? bboxFromCoordinates(geometry.coordinates);
  if (bbox) {
    result.bbox = bbox.map(roundCoordinate);
  }
  return result;
}

function countCoordinates(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0) {
    return 0;
  }
  if (typeof value[0] === "number") {
    return 1;
  }
  return value.reduce((sum, item) => sum + countCoordinates(item), 0);
}

function bboxFromCoordinates(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (typeof value[0] === "number") {
    const x = Number(value[0]);
    const y = typeof value[1] === "number" ? Number(value[1]) : 0;
    return [x, y, x, y];
  }
  let bbox: number[] | null = null;
  for (const item of value) {
    const itemBbox = bboxFromCoordinates(item);
    if (itemBbox) {
      bbox = mergeBbox(bbox, itemBbox);
    }
  }
  return bbox;
}

function mergeBbox(current: number[] | null, next: number[]): number[] {
  if (!current) {
    return [...next];
  }
  return [
    Math.min(current[0]!, next[0]!),
    Math.min(current[1]!, next[1]!),
    Math.max(current[2]!, next[2]!),
    Math.max(current[3]!, next[3]!),
  ];
}

function normalizeBbox(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 4 || !value.slice(0, 4).every((item) => typeof item === "number")) {
    return null;
  }
  return value.slice(0, 4).map(Number);
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function fieldTypeName(value: unknown): string {
  if (isRecord(value) && isGeoJson(value)) {
    return "geojson";
  }
  if (isRecord(value)) {
    return "object";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "string" && value.length > 30 && isWktGeometry(value)) {
    return "wkt_geometry";
  }
  return scalarTypeName(value);
}

function arrayItemTypeName(value: unknown): string {
  if (isRecord(value)) {
    return "object";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return scalarTypeName(value);
}

function scalarTypeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (value === undefined) {
    return "undefined";
  }
  return (value as { constructor?: { name?: string } }).constructor?.name ?? typeof value;
}

function previewScalar(value: unknown): PreviewRecord {
  if (typeof value === "string" && value.length > 30 && isWktGeometry(value)) {
    return previewWkt(value);
  }
  const preview: PreviewRecord = {
    type: scalarTypeName(value),
  };
  if (typeof value === "string") {
    preview.example = truncatePreviewText(value);
    preview.length = value.length;
  } else if (value !== null && value !== undefined) {
    preview.example = value;
  }
  return preview;
}

function isWktGeometry(value: string): boolean {
  return WKT_PATTERN.test(value);
}

function previewWkt(value: string): PreviewRecord {
  const match = WKT_PATTERN.exec(value);
  const rawType = match?.[1] ?? "Unknown";
  return {
    type: "wkt_geometry",
    geometry_type: rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase(),
    length: value.length,
    example: value.length > 60 ? `${value.slice(0, 60)}...` : value,
  };
}

function truncatePreviewText(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
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
