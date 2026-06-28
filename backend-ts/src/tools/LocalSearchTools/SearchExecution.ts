import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "../../services/agent/sdk/tool-results.js";

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_WEB_TIMEOUT_MS = 15_000;
const TODO_STATUS_VALUES = new Set(["pending", "in_progress", "completed"]);

export class LocalSearchToolService {
  private readonly dataRoot: string;
  private readonly todosBySession = new Map<string, TodoItem[]>();

  constructor(options: { dataRoot?: string | undefined } = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  }

  glob(
    input: {
      pattern: string;
      path?: string | null;
      recursive?: boolean | null;
      maxResults?: number | null;
    },
    context: ToolExecContext,
  ): ToolExecutionResult {
    const toolName = "glob";
    try {
      const pattern = input.pattern.trim();
      if (!pattern) {
        return toolError(toolName, "pattern 不能为空");
      }
      const maxResults = clampPositiveInt(input.maxResults, DEFAULT_MAX_RESULTS, 1, 5000);
      const baseRoot = this.resolveSearchRoot(input.path ?? null, context);
      const matches = globSearch(baseRoot, pattern, {
        recursive: input.recursive ?? pattern.includes("**"),
        maxResults,
      });
      const displayMatches = matches.items.map((item) => toPortableRelative(baseRoot, item));
      return toolSuccess(
        {
          base_path: baseRoot,
          pattern,
          files: displayMatches,
          count: displayMatches.length,
          truncated: matches.truncated,
        },
        {
          toolName,
          summary: `glob 匹配 ${displayMatches.length} 个文件${matches.truncated ? "（已截断）" : ""}`,
          outputType: "json",
          metadata: {
            base_path: baseRoot,
            pattern,
            count: displayMatches.length,
            truncated: matches.truncated,
          },
        },
      );
    } catch (error) {
      return toolError(toolName, `glob 执行失败: ${formatError(error)}`);
    }
  }

  grep(
    input: {
      pattern: string;
      path?: string | null;
      glob?: string | null;
      caseSensitive?: boolean | null;
      maxResults?: number | null;
      contextLines?: number | null;
    },
    context: ToolExecContext,
  ): ToolExecutionResult {
    const toolName = "grep";
    try {
      const pattern = input.pattern;
      if (!pattern.trim()) {
        return toolError(toolName, "pattern 不能为空");
      }
      const maxResults = clampPositiveInt(input.maxResults, DEFAULT_MAX_RESULTS, 1, 5000);
      const contextLines = clampPositiveInt(input.contextLines, 0, 0, 20);
      const baseRoot = this.resolveSearchRoot(input.path ?? null, context);
      const filePattern = input.glob?.trim() || "**/*";
      const files = globSearch(baseRoot, filePattern, {
        recursive: filePattern.includes("**") || !input.glob,
        maxResults: 20_000,
      }).items;
      const regexp = new RegExp(escapeRegExp(pattern), input.caseSensitive ? "" : "i");
      const matches: GrepMatch[] = [];
      let scannedFiles = 0;
      for (const filePath of files) {
        if (matches.length >= maxResults) {
          break;
        }
        if (!isLikelyTextFile(filePath)) {
          continue;
        }
        scannedFiles += 1;
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!regexp.test(line)) {
            continue;
          }
          matches.push({
            file: toPortableRelative(baseRoot, filePath),
            line_number: index + 1,
            line,
            before: contextLines > 0 ? lines.slice(Math.max(0, index - contextLines), index) : [],
            after: contextLines > 0 ? lines.slice(index + 1, Math.min(lines.length, index + 1 + contextLines)) : [],
          });
          if (matches.length >= maxResults) {
            break;
          }
        }
      }
      const truncated = matches.length >= maxResults;
      return toolSuccess(
        {
          base_path: baseRoot,
          pattern,
          matches,
          count: matches.length,
          scanned_files: scannedFiles,
          truncated,
        },
        {
          toolName,
          summary: `grep 找到 ${matches.length} 个匹配${truncated ? "（已截断）" : ""}`,
          outputType: "json",
          metadata: {
            base_path: baseRoot,
            pattern,
            count: matches.length,
            scanned_files: scannedFiles,
            truncated,
          },
        },
      );
    } catch (error) {
      return toolError(toolName, `grep 执行失败: ${formatError(error)}`);
    }
  }

  async webFetch(input: { url: string; timeoutMs?: number | null; maxChars?: number | null }): Promise<ToolExecutionResult> {
    const toolName = "web_fetch";
    try {
      const url = new URL(input.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return toolError(toolName, "仅支持 http/https URL");
      }
      const timeoutMs = clampPositiveInt(input.timeoutMs, DEFAULT_WEB_TIMEOUT_MS, 1000, 60_000);
      const maxChars = clampPositiveInt(input.maxChars, DEFAULT_MAX_CHARS, 1000, 200_000);
      const response = await fetchText(url, timeoutMs, maxChars);
      const markdown = htmlToText(response.body);
      const truncated = response.truncated || markdown.length > maxChars;
      const content = markdown.slice(0, maxChars);
      return toolSuccess(content, {
        toolName,
        summary: `已获取 ${url.toString()}，HTTP ${response.statusCode}${truncated ? "（内容已截断）" : ""}`,
        outputType: "text",
        metadata: {
          url: url.toString(),
          status_code: response.statusCode,
          content_type: response.contentType,
          truncated,
          length: content.length,
        },
      });
    } catch (error) {
      return toolError(toolName, `web_fetch 失败: ${formatError(error)}`);
    }
  }

  todoWrite(input: { todos: unknown }, context: ToolExecContext): ToolExecutionResult {
    const toolName = "todo_write";
    const sessionId = context.sessionId?.trim() || "anonymous";
    const previous = this.todosBySession.get(sessionId) ?? [];
    const parsed = parseTodos(input.todos);
    if ("error" in parsed) {
      return toolError(toolName, parsed.error);
    }
    this.todosBySession.set(sessionId, parsed.todos);
    const counts = countTodos(parsed.todos);
    return toolSuccess(
      {
        old_todos: previous,
        new_todos: parsed.todos,
        count: parsed.todos.length,
        pending_count: counts.pending,
        in_progress_count: counts.in_progress,
        completed_count: counts.completed,
      },
      {
        toolName,
        summary: parsed.todos.length
          ? `todo 列表已更新：${parsed.todos.length} 项`
          : previous.length
            ? "所有 todo 均已完成，列表已清空"
            : "todo 列表为空",
        outputType: "json",
        metadata: {
          session_id: sessionId,
          count: parsed.todos.length,
          pending_count: counts.pending,
          in_progress_count: counts.in_progress,
          completed_count: counts.completed,
        },
      },
    );
  }

  private resolveSearchRoot(rawPath: string | null, context: ToolExecContext): string {
    const workspaceRoot = normalizeString(context.workspaceRoot) ?? null;
    const root = workspaceRoot ?? (context.sessionId ? path.join(this.dataRoot, "sessions", context.sessionId, "workspace") : this.dataRoot);
    const candidate = rawPath?.trim() ? path.resolve(root, rawPath) : path.resolve(root);
    const allowedRoots = [path.resolve(root), path.resolve(this.dataRoot)];
    if (!allowedRoots.some((allowedRoot) => isPathUnder(candidate, allowedRoot))) {
      throw new Error(`路径 '${rawPath}' 超出允许的受管目录范围，禁止访问`);
    }
    if (!fs.existsSync(candidate)) {
      throw new Error(`路径不存在: ${rawPath ?? root}`);
    }
    if (!fs.statSync(candidate).isDirectory()) {
      throw new Error(`路径不是目录: ${rawPath ?? root}`);
    }
    return candidate;
  }
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string | undefined;
}

interface GrepMatch {
  file: string;
  line_number: number;
  line: string;
  before: string[];
  after: string[];
}

function globSearch(
  baseRoot: string,
  pattern: string,
  options: { recursive: boolean; maxResults: number },
): { items: string[]; truncated: boolean } {
  const matcher = createGlobMatcher(pattern);
  const results: string[] = [];
  let truncated = false;
  const visit = (directory: string, depth: number): void => {
    if (results.length >= options.maxResults) {
      truncated = true;
      return;
    }
    const entries = safeReadDir(directory);
    for (const entry of entries) {
      if (results.length >= options.maxResults) {
        truncated = true;
        return;
      }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (options.recursive || depth === 0) {
          visit(fullPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relative = toPortableRelative(baseRoot, fullPath);
      if (matcher(relative)) {
        results.push(fullPath);
      }
    }
  };
  visit(baseRoot, 0);
  results.sort((left, right) => left.localeCompare(right));
  return { items: results, truncated };
}

function createGlobMatcher(pattern: string): (relativePath: string) => boolean {
  const normalized = pattern.replace(/\\/g, "/");
  const regex = new RegExp(`^${globToRegex(normalized)}$`);
  return (relativePath) => regex.test(relativePath.replace(/\\/g, "/"));
}

function globToRegex(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      output += ".*";
      index += 1;
      if (pattern[index + 1] === "/") {
        output += "\\/?";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      output += "[^/]*";
      continue;
    }
    if (char === "?") {
      output += "[^/]";
      continue;
    }
    output += escapeRegExp(char ?? "");
  }
  return output;
}

function safeReadDir(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isLikelyTextFile(filePath: string): boolean {
  try {
    const buffer = fs.readFileSync(filePath);
    return !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
  } catch {
    return false;
  }
}

function parseTodos(value: unknown): { todos: TodoItem[] } | { error: string } {
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
    const todo: TodoItem = {
      content,
      status: status as TodoItem["status"],
    };
    const activeForm = normalizeString(item.active_form) ?? normalizeString(item.activeForm);
    if (activeForm) {
      todo.activeForm = activeForm;
    }
    todos.push(todo);
  }
  return { todos };
}

function countTodos(todos: TodoItem[]): Record<TodoItem["status"], number> {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) {
    counts[todo.status] += 1;
  }
  return counts;
}

async function fetchText(
  url: URL,
  timeoutMs: number,
  maxChars: number,
): Promise<{ statusCode: number; contentType: string; body: string; truncated: boolean }> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { timeout: timeoutMs }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const contentType = String(response.headers["content-type"] ?? "");
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        const redirectUrl = new URL(response.headers.location, url);
        fetchText(redirectUrl, timeoutMs, maxChars).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      let totalLength = 0;
      let truncated = false;
      response.on("data", (chunk: Buffer) => {
        if (totalLength < maxChars) {
          chunks.push(chunk);
        }
        totalLength += chunk.length;
        if (totalLength > maxChars) {
          truncated = true;
          response.destroy();
        }
      });
      response.on("end", () => {
        resolve({
          statusCode,
          contentType,
          body: Buffer.concat(chunks).toString("utf8"),
          truncated,
        });
      });
      response.on("close", () => {
        resolve({
          statusCode,
          contentType,
          body: Buffer.concat(chunks).toString("utf8"),
          truncated,
        });
      });
      response.on("error", reject);
    });
    request.on("timeout", () => {
      request.destroy(new Error(`请求超时: ${timeoutMs}ms`));
    });
    request.on("error", reject);
  });
}

function htmlToText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampPositiveInt(value: number | null | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function toPortableRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
