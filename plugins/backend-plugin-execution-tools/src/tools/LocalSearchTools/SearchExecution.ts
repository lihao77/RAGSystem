import path from "node:path";

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
import { WebFetchClient } from "../WebFetchTool/web-fetch-client.js";
import { WebFetchError } from "../WebFetchTool/web-fetch-policy.js";
import { renderBody } from "../WebFetchTool/web-fetch-markdown.js";

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_WEB_TIMEOUT_MS = 15_000;
const WEB_TRUNCATION_FOOTER = "\n\n(内容已截断；请抓取更具体的 URL 或页面段落获取全文。)";

export class LocalSearchToolService {
  private readonly dataRoot: string;
  private readonly paths: ManagedPathResolver;
  private readonly todosBySession = new Map<string, TodoItem[]>();
  private readonly webFetchClient: WebFetchClient;

  constructor(options: {
    dataRoot?: string | undefined;
    pathResolver?: ManagedPathResolver | undefined;
    webFetchClient?: WebFetchClient | undefined;
  } = {}) {
    if (!options.dataRoot?.trim()) {
      throw new Error("LocalSearchToolService 必须传入已解析的 dataRoot");
    }
    this.dataRoot = path.resolve(options.dataRoot);
    this.paths = options.pathResolver ?? new ManagedPathResolver(this.dataRoot);
    this.webFetchClient = options.webFetchClient ?? new WebFetchClient();
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

  /**
   * web_fetch：公网校验 + 地址钉扎的 HTTP(S) 抓取（gzip 自动解压、同源重定向
   * 有限跟随、字节/字符双层上限、按声明字符集解码），HTML 经 turndown 转
   * markdown（非可见内容剔除 + 嵌套深度护栏）。
   */
  async webFetch(
    input: { url: string; timeoutMs?: number | null; maxChars?: number | null },
    context?: ToolExecContext,
  ): Promise<ToolExecutionResult> {
    const toolName = "web_fetch";
    try {
      const timeoutMs = clampPositiveInt(input.timeoutMs, DEFAULT_WEB_TIMEOUT_MS, 1000, 60_000);
      const maxChars = clampPositiveInt(input.maxChars, DEFAULT_MAX_CHARS, 1000, 200_000);
      const outcome = await this.webFetchClient.fetch(input.url, { timeoutMs, signal: context?.signal });
      const rendered = renderBody(outcome.body, maxChars);
      const truncated = outcome.truncated || rendered.sourceTruncated || rendered.text.length > maxChars;
      // 尾部截断说明计入 max_chars 总预算（对齐参考实现：header/footer 都算输出的一部分）。
      let content = rendered.text;
      if (truncated) {
        const bodyBudget = Math.max(0, maxChars - WEB_TRUNCATION_FOOTER.length);
        if (content.length > bodyBudget) content = content.slice(0, bodyBudget);
        content += WEB_TRUNCATION_FOOTER;
      }
      return toolSuccess(content, {
        toolName,
        summary: `已获取 ${outcome.url}，HTTP ${outcome.statusCode}${truncated ? "（内容已截断）" : ""}`,
        outputType: "text",
        metadata: {
          url: outcome.url,
          status_code: outcome.statusCode,
          content_type: outcome.contentType,
          truncated,
          length: content.length,
        },
      });
    } catch (error) {
      if (error instanceof WebFetchError) {
        return toolError(toolName, `web_fetch 失败（${error.code}）: ${error.message}`);
      }
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

function clampPositiveInt(value: number | null | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
