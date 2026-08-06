import { isRecord, normalizeString } from "@ragsystem/backend-core/utils/guards.js";
import type { ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";

const DEFAULT_MAX_RESULTS = 200;
const TODO_STATUS_VALUES = new Set(["pending", "in_progress", "completed"]);

export interface GlobInput {
  pattern: string;
  path?: string | null;
  recursive?: boolean | null;
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
    recursive: input.recursive ?? pattern.includes("**"),
    maxResults: clampPositiveInt(input.maxResults, DEFAULT_MAX_RESULTS, 1, 5_000),
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
    caseSensitive: input.caseSensitive === true,
    maxResults: clampPositiveInt(input.maxResults, DEFAULT_MAX_RESULTS, 1, 5_000),
    contextLines: clampPositiveInt(input.contextLines, 0, 0, 20),
  };
}

export function formatGlobResult(
  basePath: string,
  input: Pick<NormalizedGlobInput, "pattern">,
  files: string[],
  truncated: boolean,
  metadata: Record<string, unknown> = {},
): ToolExecutionResult {
  return toolSuccess(
    { base_path: basePath, pattern: input.pattern, files, count: files.length, truncated },
    {
      toolName: "glob",
      summary: `glob 匹配 ${files.length} 个文件${truncated ? "（已截断）" : ""}`,
      outputType: "json",
      metadata: { ...metadata, base_path: basePath, pattern: input.pattern, count: files.length, truncated },
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
): ToolExecutionResult {
  return toolSuccess(
    { base_path: basePath, pattern: input.pattern, matches, count: matches.length, scanned_files: scannedFiles, truncated },
    {
      toolName: "grep",
      summary: `grep 找到 ${matches.length} 个匹配${truncated ? "（已截断）" : ""}`,
      outputType: "json",
      metadata: {
        ...metadata,
        base_path: basePath,
        pattern: input.pattern,
        count: matches.length,
        scanned_files: scannedFiles,
        truncated,
      },
    },
  );
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
