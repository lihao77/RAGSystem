import { isRecord, normalizeString } from "@ragsystem/backend-core/utils/guards.js";
import type { ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";

/** grep 默认内联保留匹配数（对齐业界 harness 的 head_limit 默认值）。 */
export const DEFAULT_GREP_MAX_RESULTS = 250;
/** glob 默认内联保留路径数。 */
export const DEFAULT_GLOB_MAX_RESULTS = 100;
/** 单条匹配行预览的字节上限；截断保留 UTF-8 边界并标注 (line truncated)。 */
export const GREP_MAX_LINE_BYTES = 2_000;
const TODO_STATUS_VALUES = new Set(["pending", "in_progress", "completed"]);

export interface GlobInput {
  pattern: string;
  path?: string | null;
  maxResults?: number | null;
}

export interface GrepInput {
  pattern: string;
  path?: string | null;
  glob?: string | null;
  caseSensitive?: boolean | null;
  maxResults?: number | null;
  contextLines?: number | null;
}

export interface NormalizedGlobInput {
  pattern: string;
  path: string | null;
  recursive: boolean;
  maxResults: number;
}

export interface NormalizedGrepInput {
  pattern: string;
  path: string | null;
  glob: string;
  caseSensitive: boolean;
  maxResults: number;
  contextLines: number;
}

export interface GrepMatch {
  file: string;
  line_number: number;
  line: string;
  before: string[];
  after: string[];
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string | undefined;
}

export function normalizeGlobInput(input: GlobInput): NormalizedGlobInput | { error: string } {
  const pattern = input.pattern.trim();
  if (!pattern) {
    return { error: "pattern 不能为空" };
  }
  return {
    pattern,
    path: input.path ?? null,
    // glob 深度由 pattern 自身表达（无 "/" 匹配任意深度的 basename）；
    // 恒为 true 仅为兼容存量沙箱 wire 契约（SandboxGlobInput.recursive）。
    recursive: true,
    maxResults: clampPositiveInt(input.maxResults, DEFAULT_GLOB_MAX_RESULTS, 1, 5_000),
  };
}

export function normalizeGrepInput(input: GrepInput): NormalizedGrepInput | { error: string } {
  const pattern = input.pattern;
  if (!pattern.trim()) {
    return { error: "pattern 不能为空" };
  }
  const glob = input.glob?.trim() || "**/*";
  return {
    pattern,
    path: input.path ?? null,
    glob,
    // 与 ripgrep/业界 grep 工具一致：默认大小写敏感；忽略大小写需显式 case_sensitive=false（或正则 (?i)）。
    caseSensitive: input.caseSensitive !== false,
    maxResults: clampPositiveInt(input.maxResults, DEFAULT_GREP_MAX_RESULTS, 1, 5_000),
    contextLines: clampPositiveInt(input.contextLines, 0, 0, 20),
  };
}

export function formatGlobResult(
  basePath: string,
  input: Pick<NormalizedGlobInput, "pattern">,
  files: string[],
  truncated: boolean,
  metadata: Record<string, unknown> = {},
  totalFiles?: number,
): ToolExecutionResult {
  const total = totalFiles ?? files.length;
  return toolSuccess(
    { base_path: basePath, pattern: input.pattern, files, count: files.length, total_files: total, truncated },
    {
      toolName: "glob",
      summary: `glob 匹配 ${files.length} 个文件${total > files.length ? `（共 ${total}，已截断）` : ""}`,
      outputType: "json",
      metadata: { ...metadata, base_path: basePath, pattern: input.pattern, count: files.length, total_files: total, truncated },
    },
  );
}

export function formatGrepResult(
  basePath: string,
  input: Pick<NormalizedGrepInput, "pattern">,
  matches: GrepMatch[],
  scannedFiles: number,
  truncated: boolean,
  metadata: Record<string, unknown> = {},
  totalMatches?: number,
): ToolExecutionResult {
  const total = totalMatches ?? matches.length;
  return toolSuccess(
    {
      base_path: basePath,
      pattern: input.pattern,
      matches,
      count: matches.length,
      total_matches: total,
      scanned_files: scannedFiles,
      truncated,
    },
    {
      toolName: "grep",
      summary: `grep 找到 ${matches.length} 个匹配${total > matches.length ? `（共 ${total}，已截断）` : ""}`,
      outputType: "json",
      metadata: {
        ...metadata,
        base_path: basePath,
        pattern: input.pattern,
        count: matches.length,
        total_matches: total,
        scanned_files: scannedFiles,
        truncated,
      },
    },
  );
}

/**
 * 把单条匹配行预览限制在 maxBytes 内（截断点回退到 UTF-8 序列边界），
 * 截断时追加 " (line truncated)" 标注——完整行仍在源文件里可由 read 工具读取。
 */
export function previewLine(line: string, maxBytes: number = GREP_MAX_LINE_BYTES): string {
  const buffer = Buffer.from(line, "utf8");
  if (buffer.byteLength <= maxBytes) return line;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  if (end === 0) end = maxBytes;
  return `${buffer.subarray(0, end).toString("utf8")} (line truncated)`;
}

export function parseTodos(value: unknown): { todos: TodoItem[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: "todos 必须是数组" };
  }
  const todos: TodoItem[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return { error: `todos[${index}] 必须是对象` };
    }
    const content = normalizeString(item.content);
    if (!content) {
      return { error: `todos[${index}].content 不能为空` };
    }
    const status = normalizeString(item.status) ?? "pending";
    if (!TODO_STATUS_VALUES.has(status)) {
      return { error: `todos[${index}].status 非法值 '${status}'` };
    }
    const todo: TodoItem = { content, status: status as TodoItem["status"] };
    const activeForm = normalizeString(item.active_form) ?? normalizeString(item.activeForm);
    if (activeForm) {
      todo.activeForm = activeForm;
    }
    todos.push(todo);
  }
  return { todos };
}

export function formatTodoWriteResult(
  previous: TodoItem[],
  next: TodoItem[],
  sessionId: string,
): ToolExecutionResult {
  const counts = countTodos(next);
  return toolSuccess(
    {
      old_todos: previous,
      new_todos: next,
      count: next.length,
      pending_count: counts.pending,
      in_progress_count: counts.in_progress,
      completed_count: counts.completed,
    },
    {
      toolName: "todo_write",
      summary: next.length
        ? `todo 列表已更新：${next.length} 项`
        : previous.length
          ? "所有 todo 均已完成，列表已清空"
          : "todo 列表为空",
      outputType: "json",
      metadata: {
        session_id: sessionId,
        count: next.length,
        pending_count: counts.pending,
        in_progress_count: counts.in_progress,
        completed_count: counts.completed,
      },
    },
  );
}

export function invalidSearchResult(toolName: "glob" | "grep", error: string): ToolExecutionResult {
  return toolError(toolName, error);
}

function countTodos(todos: TodoItem[]): Record<TodoItem["status"], number> {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) {
    counts[todo.status] += 1;
  }
  return counts;
}

function clampPositiveInt(value: number | null | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}
