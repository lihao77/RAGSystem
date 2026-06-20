import { z } from "zod";

import type { LocalDocumentToolService } from "./DocumentExecution.js";
import {
  editFileArguments,
  previewDataStructureArguments,
  readFileArguments,
  writeFileArguments,
} from "../../services/runtime/runtime-tool-bridge/arguments.js";
import {
  EDIT_FILE_TOOL_NAME,
  PREVIEW_DATA_STRUCTURE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from "../../services/runtime/runtime-tool-bridge/registry.js";
import type { RuntimeToolDefinition } from "../../services/runtime/runtime-tool-types.js";
import { buildTool, type RuntimeTool } from "../Tool.js";
import { optionalInteger, optionalString, metadataFrom } from "../schema-helpers.js";

interface DocumentToolDeps {
  documentTools: LocalDocumentToolService | null;
}

const readFileSchema = z.object({
  file_path: z.string(),
  filePath: z.string().optional(),
  file_path_space: optionalString,
  filePathSpace: optionalString,
  encoding: optionalString,
  offset: optionalInteger,
  limit: optionalInteger,
}).strict();

const writeFileSchema = z.object({
  content: z.unknown(),
  file_path: optionalString,
  filePath: optionalString,
  file_path_space: optionalString,
  filePathSpace: optionalString,
  mode: optionalString,
  encoding: optionalString,
}).strict();

const editFileSchema = z.object({
  file_path: z.string(),
  filePath: z.string().optional(),
  old_string: z.string(),
  oldString: z.string().optional(),
  new_string: z.string(),
  newString: z.string().optional(),
  replace_all: z.boolean().optional().nullable(),
  replaceAll: z.boolean().optional().nullable(),
  file_path_space: optionalString,
  filePathSpace: optionalString,
  encoding: optionalString,
}).strict();

const previewDataStructureSchema = z.object({
  file_path: z.string(),
  filePath: z.string().optional(),
  file_path_space: optionalString,
  filePathSpace: optionalString,
  encoding: optionalString,
  max_preview_rows: optionalInteger,
  maxPreviewRows: optionalInteger,
  max_depth: optionalInteger,
  maxDepth: optionalInteger,
  max_fields: optionalInteger,
  maxFields: optionalInteger,
}).strict();

export const DOCUMENT_TOOLS: RuntimeToolDefinition[] = [
  {
    name: READ_FILE_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description:
      "Read a managed workspace/session file by line range. Defaults to line 1 and at most 2000 lines. Use offset/limit for large files.",
    returns: {
      description: "成功时返回文件内容和分页元数据。",
      shape: {
        content: "string",
        metadata: {
          file_path: "string",
          file_size: "number",
          total_lines: "number",
          start_line: "number",
          end_line: "number",
          has_more: "boolean",
          next_offset: "number|null",
        },
      },
    },
    usage_contract: [
      "read_file 默认只返回前 2000 行；大文件请用 metadata.next_offset 继续分页。",
      "可用 offset/limit 指定行号区间。",
      "返回内容为文件原始文本内容，不附带行号。",
      "file_path 必须是真实路径字符串，不是变量名文本。",
      "数据文件已有路径时，优先用 preview_data_structure 确认结构。",
    ],
    examples: [
      {
        input: { file_path: "tmp.txt" },
        xml_attrs: { file_path: { space: "transient" } },
        result_hint: { content: "temporary text" },
      },
      {
        input: { file_path: "./data/large.txt", offset: 100, limit: 50 },
        result_hint: {
          content: "line 100 ...",
          metadata: { start_line: 100, end_line: 149, has_more: true, next_offset: 150 },
        },
      },
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: {
        file_path: {
          type: "string",
          description: "File path. Relative paths resolve against the current workspace first, then session managed directories.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "1-based starting line number. Defaults to 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Maximum lines to read. Defaults to 2000.",
        },
      },
    },
  },
  {
    name: WRITE_FILE_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "high",
    allowed_callers: ["direct"],
    description:
      "Write text or JSON content to a managed workspace/session file. If file_path is omitted, the runtime allocates a managed output path.",
    returns: {
      description: "成功时返回保存后的文件信息。",
      shape: {
        file_path: "string",
        file_size: "number",
        display_path: "string",
      },
    },
    usage_contract: [
      "content 是最终要写入的文本；JSON 请先序列化成字符串。",
      "后续工具需要路径时，优先复用返回的 file_path。",
      "修改已有文件的部分内容时，请优先使用 edit_file。",
    ],
    examples: [
      {
        input: { content: "temporary text", file_path: "tmp.txt" },
        xml_attrs: { file_path: { space: "transient" } },
        result_hint: { display_path: "./data/sessions/<session_id>/transient/tmp.txt" },
      },
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: {
          description: "Content to write. Strings are written as text; objects are serialized when mode=json.",
        },
        file_path: {
          type: "string",
          description: "Optional file path. Relative paths resolve to managed workspace/session roots.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        mode: {
          type: "string",
          enum: ["text", "json"],
          description: "Write mode. Defaults to text.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
      },
    },
  },
  {
    name: EDIT_FILE_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "high",
    allowed_callers: ["direct"],
    description:
      "Edit a managed file by exact string replacement. old_string must match uniquely unless replace_all=true.",
    returns: {
      description: "成功时返回编辑后的文件信息。",
      shape: {
        file_path: "string",
        replacements: "number",
        display_path: "string",
      },
    },
    usage_contract: [
      "old_string 必须与文件内容精确匹配，包含空白和换行。",
      "默认要求唯一匹配；需要批量替换时显式传 replace_all=true。",
      "编辑已有文件优先使用 edit_file，不要用 write_file 重写整文件。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path", "old_string", "new_string"],
      properties: {
        file_path: {
          type: "string",
          description: "File path to edit. Relative paths resolve to managed workspace/session roots.",
        },
        old_string: {
          type: "string",
          description: "Exact text to replace. Must include whitespace/newlines exactly.",
        },
        new_string: {
          type: "string",
          description: "Replacement text. Empty string deletes old_string.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all matches instead of requiring a unique match.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
      },
    },
  },
  {
    name: PREVIEW_DATA_STRUCTURE_TOOL_NAME,
    source: "document",
    category: "data",
    riskLevel: "low",
    allowed_callers: ["direct", "code_execution"],
    description:
      "Preview the data structure of a managed JSON, YAML, CSV, TSV, or text file without returning the full file content.",
    returns: {
      description: "成功时返回文件类型、基础元信息和结构预览结果。",
      shape: {
        content: {
          file_path: "string",
          file_name: "string",
          file_type: "string",
          file_size: "number",
          structure: "object",
        },
        metadata: {
          file_type: "string",
          file_size: "number",
          max_preview_rows: "number",
          max_depth: "number",
          max_fields: "number",
        },
      },
    },
    usage_contract: [
      "适合先探索数据结构，再决定是否调用 read_file 或直接进入后续处理步骤。",
      "JSON/YAML 返回层级结构预览；CSV/TSV 返回列与样例行；文本返回行统计与预览。",
      "想看更深层结构时可提高 max_depth；想看更多列或样例可提高 max_fields/max_preview_rows。",
    ],
    examples: [
      {
        input: { file_path: "./data/sample.json", max_depth: 2 },
        result_hint: { file_type: "json", structure: { type: "object" } },
      },
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: {
        file_path: {
          type: "string",
          description: "File path to preview. Relative paths resolve against managed workspace/session roots.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
        max_preview_rows: {
          type: "integer",
          minimum: 1,
          description: "Maximum sampled table rows, text lines, or array items. Defaults to 5.",
        },
        max_depth: {
          type: "integer",
          minimum: 1,
          description: "Maximum nested structure depth for JSON/YAML. Defaults to 3.",
        },
        max_fields: {
          type: "integer",
          minimum: 1,
          description: "Maximum object fields or table columns to summarize. Defaults to 20.",
        },
      },
    },
  },
];

export function createDocumentTools(deps: DocumentToolDeps): RuntimeTool[] {
  const definitionByName = new Map(DOCUMENT_TOOLS.map((definition) => [definition.name, definition]));
  const documentTools = deps.documentTools;
  if (!documentTools) {
    return [];
  }
  return [
    buildTool({
      ...metadataFrom(definitionByName.get(READ_FILE_TOOL_NAME)!),
      inputSchema: readFileSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input, context) => documentTools.readFile(readFileArguments(input), context),
      getExternalPathApprovalCandidates: (input, context) =>
        documentTools.getExternalPathApprovalCandidates(READ_FILE_TOOL_NAME, input, context),
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(WRITE_FILE_TOOL_NAME)!),
      inputSchema: writeFileSchema,
      call: (input, context) => documentTools.writeFile(writeFileArguments(input), context),
      getExternalPathApprovalCandidates: (input, context) =>
        documentTools.getExternalPathApprovalCandidates(WRITE_FILE_TOOL_NAME, input, context),
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(EDIT_FILE_TOOL_NAME)!),
      inputSchema: editFileSchema,
      call: (input, context) => documentTools.editFile(editFileArguments(input), context),
      getExternalPathApprovalCandidates: (input, context) =>
        documentTools.getExternalPathApprovalCandidates(EDIT_FILE_TOOL_NAME, input, context),
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(PREVIEW_DATA_STRUCTURE_TOOL_NAME)!),
      inputSchema: previewDataStructureSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input, context) => documentTools.previewDataStructure(previewDataStructureArguments(input), context),
      getExternalPathApprovalCandidates: (input, context) =>
        documentTools.getExternalPathApprovalCandidates(PREVIEW_DATA_STRUCTURE_TOOL_NAME, input, context),
    }),
  ];
}
