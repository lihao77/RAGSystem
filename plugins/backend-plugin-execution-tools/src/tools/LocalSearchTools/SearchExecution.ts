import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";

import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import { ManagedPathResolver } from "../../paths/managed-path-resolver.js";
import {
  formatGlobResult,
  formatGrepResult,
  formatTodoWriteResult,
  normalizeGlobInput,
  normalizeGrepInput,
  parseTodos,
  previewLine,
  type GlobInput,
  type GrepInput,
  type TodoItem,
} from "../shared/search-policy.js";
import {
  parseGlobOutput,
  parseGrepJsonOutput,
  RipgrepError,
  runRipgrep,
  VCS_EXCLUDE_GLOBS,
} from "./ripgrep-engine.js";

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

  getSearchRootCandidates(
    rawPath: string | null | undefined,
    context: ToolExecContext,
    pathService: PathAccessPolicy,
  ): string[] {
    return this.paths.getSearchRootCandidates(rawPath, context, pathService);
  }

  /**
   * glob（文件发现）：rg --files --sort=modified --no-ignore --hidden + VCS 目录双重排除。
   * 发现语义要穿透 ignore/隐藏文件才能回答"有哪些文件"；按修改时间排序回答"最近改了什么"。
   */
  async glob(
    input: GlobInput,
    context: ToolExecContext,
    pathService?: PathAccessPolicy,
  ): Promise<ToolExecutionResult> {
    const toolName = "glob";
    try {
      const normalized = normalizeGlobInput(input);
      if ("error" in normalized) return toolError(toolName, normalized.error);
      const baseRoot = this.paths.resolveSearchRoot(normalized.path, context, pathService);
      const argv = ["--files", `--glob=${normalized.pattern}`, "--sort=modified", "--no-ignore", "--hidden"];
      for (const name of VCS_EXCLUDE_GLOBS) {
        argv.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`);
      }
      argv.push("--", ".");
      const run = await runRipgrep({ argv, cwd: baseRoot, signal: context.signal });
      const all = run.noMatches ? [] : parseGlobOutput(run.stdout);
      const retained = all.slice(0, normalized.maxResults);
      return formatGlobResult(
        baseRoot,
        normalized,
        retained,
        all.length > retained.length,
        { execution_paths: this.paths.roots(context) },
        all.length,
      );
    } catch (error) {
      return toolError(toolName, `glob 执行失败: ${formatError(error)}`);
    }
  }

  /**
   * grep（内容搜索）：rg --json 正则搜索。默认大小写敏感；显式 --hidden 让
   * agent 能搜到自己写的点文件（受管工作区不是源码仓库），ignore 规则
   * （.gitignore/.ignore）保持尊重以挡住 node_modules 类噪音，二进制由 rg 跳过。
   */
  async grep(
    input: GrepInput,
    context: ToolExecContext,
    pathService?: PathAccessPolicy,
  ): Promise<ToolExecutionResult> {
    const toolName = "grep";
    try {
      const normalized = normalizeGrepInput(input);
      if ("error" in normalized) return toolError(toolName, normalized.error);
      const baseRoot = this.paths.resolveSearchRoot(normalized.path, context, pathService);
      const argv = ["--json", `--regexp=${normalized.pattern}`];
      if (!normalized.caseSensitive) argv.push("--ignore-case");
      if (normalized.glob !== "**/*") argv.push(`--glob=${normalized.glob}`);
      if (normalized.contextLines > 0) argv.push(`--context=${normalized.contextLines}`);
      // 显式包含隐藏文件（受管工作区不是源码仓库，agent 需要搜到自己写的点文件），
      // 但 VCS 元数据目录与 glob 一样永远排除，避免 .git 噪音进入匹配结果。
      argv.push("--hidden");
      for (const name of VCS_EXCLUDE_GLOBS) {
        argv.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`);
      }
      argv.push("--", ".");
      const run = await runRipgrep({ argv, cwd: baseRoot, signal: context.signal });
      // 零匹配（exit 1）时 rg 仍输出带 stats.searches 的 summary，照常解析以如实上报扫描数。
      const parsed = parseGrepJsonOutput(run.stdout, normalized.contextLines);
      const retained = parsed.matches.slice(0, normalized.maxResults);
      for (const match of retained) {
        match.line = previewLine(match.line);
        match.before = match.before.map((line) => previewLine(line));
        match.after = match.after.map((line) => previewLine(line));
      }
      return formatGrepResult(
        baseRoot,
        normalized,
        retained,
        parsed.scannedFiles,
        parsed.matches.length > retained.length,
        { execution_paths: this.paths.roots(context) },
        parsed.matches.length,
      );
    } catch (error) {
      if (error instanceof RipgrepError && error.kind === "invalid_pattern") {
        return toolError(toolName, `grep pattern 非法（ripgrep 正则）: ${error.message}`);
      }
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

async function fetchText(
  url: URL,
  timeoutMs: number,
  maxChars: number,
): Promise<{ statusCode: number; contentType: string; body: string; truncated: boolean }> {
  const client = url.protocol === "https://" ? https : http;
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
