import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";

import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import { ManagedPathResolver } from "../../paths/managed-path-resolver.js";
import {
  formatGlobResult,
  formatGrepResult,
  formatTodoWriteResult,
  normalizeGlobInput,
  normalizeGrepInput,
  parseTodos,
  type GlobInput,
  type GrepInput,
  type GrepMatch,
  type TodoItem,
} from "../shared/search-policy.js";

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_WEB_TIMEOUT_MS = 15_000;

export class LocalSearchToolService {
  private readonly dataRoot: string;
  private readonly paths: ManagedPathResolver;
  private readonly todosBySession = new Map<string, TodoItem[]>();

  constructor(options: { dataRoot?: string | undefined; pathResolver?: ManagedPathResolver | undefined } = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("LocalSearchToolService 必须传入已解析的 dataRoot");
    }
    this.dataRoot = path.resolve(options.dataRoot);
    this.paths = options.pathResolver ?? new ManagedPathResolver(this.dataRoot);
  }

  glob(
    input: GlobInput,
    context: ToolExecContext,
  ): ToolExecutionResult {
    const toolName = "glob";
    try {
      const normalized = normalizeGlobInput(input);
      if ("error" in normalized) return toolError(toolName, normalized.error);
      const baseRoot = this.paths.resolveSearchRoot(normalized.path, context);
      const matches = globSearch(baseRoot, normalized.pattern, {
        recursive: normalized.recursive,
        maxResults: normalized.maxResults,
      });
      const displayMatches = matches.items.map((item) => toPortableRelative(baseRoot, item));
      return formatGlobResult(baseRoot, normalized, displayMatches, matches.truncated, {
        execution_paths: this.paths.roots(context),
      });
    } catch (error) {
      return toolError(toolName, `glob 执行失败: ${formatError(error)}`);
    }
  }

  grep(
    input: GrepInput,
    context: ToolExecContext,
  ): ToolExecutionResult {
    const toolName = "grep";
    try {
      const normalized = normalizeGrepInput(input);
      if ("error" in normalized) return toolError(toolName, normalized.error);
      const baseRoot = this.paths.resolveSearchRoot(normalized.path, context);
      const files = globSearch(baseRoot, normalized.glob, {
        recursive: normalized.glob.includes("**") || !input.glob,
        maxResults: 20_000,
      }).items;
      const regexp = new RegExp(escapeRegExp(normalized.pattern), normalized.caseSensitive ? "" : "i");
      const matches: GrepMatch[] = [];
      let scannedFiles = 0;
      for (const filePath of files) {
        if (matches.length >= normalized.maxResults) {
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
            before: normalized.contextLines > 0 ? lines.slice(Math.max(0, index - normalized.contextLines), index) : [],
            after: normalized.contextLines > 0 ? lines.slice(index + 1, Math.min(lines.length, index + 1 + normalized.contextLines)) : [],
          });
          if (matches.length >= normalized.maxResults) {
            break;
          }
        }
      }
      const truncated = matches.length >= normalized.maxResults;
      return formatGrepResult(baseRoot, normalized, matches, scannedFiles, truncated, {
        execution_paths: this.paths.roots(context),
      });
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
    return formatTodoWriteResult(previous, parsed.todos, sessionId);
  }

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


function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
