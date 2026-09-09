/**
 * ripgrep 内核——本地搜索工具（glob/grep）的统一执行引擎。
 *
 * 设计对齐业界已验证的 harness 形态（deepseek-harness tool-fs-search /
 * Claude Code GrepTool）：
 * - 不自实现遍历与匹配，spawn 随包分发的 ripgrep 二进制（@vscode/ripgrep），
 *   语义与模型训练语料中的 grep/rg 经验一致（正则、大小写默认敏感、尊重
 *   .gitignore/.ignore、自动跳过二进制）；
 * - argv 直传（无 shell 层），模式走 `--regexp=`，搜索根放 `--` 之后，
 *   前置 `--no-config` 阻断宿主 RIPGREP_CONFIG_PATH 注入 `--pre` 预处理器；
 * - grep 用 `rg --json`（NDJSON）传输，避免冒号切分歧义；exit 1 = 零匹配的
 *   成功；非 0/1 退出按 stderr 分类（pattern 非法 / 执行失败）；
 * - 原始 stdout 在 20MB 上限内完整采集，超限显式报错（绝不静默解析半截流）；
 * - 超时 30s：到点直接终止子进程并按超时报错（AbortSignal 全链路传导）。
 */
import { spawn } from "node:child_process";
import type { GrepMatch } from "../shared/search-policy.js";

/** 完整采集的原始 rg stdout 上限（对齐业界 harness 的 ripgrep 原始缓冲默认值）。 */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000;
/** stderr 诊断尾巴上限（仅用于错误消息，成功路径不展示）。 */
export const STDERR_MAX_BYTES = 64 * 1024;
/** 单次搜索的协作式超时。 */
export const SEARCH_TIMEOUT_MS = 30_000;
/**
 * glob（文件发现）必须穿透 ignore/hidden 才能回答"有哪些文件"，
 * 但 VCS 元数据目录永远排除。双重否定 glob：裸形在遍历期剪枝目录，
 * `/**` 形在搜索根本身位于该目录内时仍能排除其内容。
 */
export const VCS_EXCLUDE_GLOBS: readonly string[] = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

export interface RipgrepRunOutcome {
  stdout: string;
  /** rg exit 1：搜索成功且零结果。 */
  noMatches: boolean;
}

export class RipgrepError extends Error {
  constructor(message: string, readonly kind: "invalid_pattern" | "launch" | "overflow" | "timeout" | "aborted" | "failed") {
    super(message);
    this.name = "RipgrepError";
  }
}

let rgPathPromise: Promise<string> | undefined;

/** 解析随包分发的 ripgrep 二进制路径（懒解析、进程内记忆化）。 */
export function resolveRgPath(): Promise<string> {
  rgPathPromise ??= import("@vscode/ripgrep").then((pkg) => pkg.rgPath);
  return rgPathPromise;
}

/**
 * 运行 ripgrep 并完整采集 stdout。argv 由调用方构建（本模块统一前置
 * `--no-config`）；cwd 即搜索根，rg 输出的路径天然相对该根。
 */
export async function runRipgrep(options: {
  argv: readonly string[];
  cwd: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}): Promise<RipgrepRunOutcome> {
  const rgPath = await resolveRgPath().catch((error: unknown) => {
    throw new RipgrepError(
      `ripgrep 二进制不可用（@vscode/ripgrep 解析失败: ${errorMessage(error)}）；请重装依赖后重试`,
      "launch",
    );
  });
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  return new Promise<RipgrepRunOutcome>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new RipgrepError("搜索已在完成前被中止", "aborted"));
      return;
    }
    const child = spawn(rgPath, ["--no-config", ...options.argv], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      finish(new RipgrepError(`搜索超时（${timeoutMs}ms），已终止；请收窄 pattern/path/glob 后重试`, "timeout"));
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      finish(new RipgrepError("搜索已在完成前被中止（工具超时或调用方取消）", "aborted"));
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.byteLength > RAW_OUTPUT_MAX_BYTES) {
        finish(new RipgrepError(
          `搜索原始输出超过 ${RAW_OUTPUT_MAX_BYTES} 字节上限；请收窄 pattern/path/glob 后重试`,
          "overflow",
        ));
        child.kill("SIGKILL");
        return;
      }
      stdoutBytes += chunk.byteLength;
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.byteLength <= STDERR_MAX_BYTES) {
        stderrBytes += chunk.byteLength;
        stderrChunks.push(chunk);
      }
    });
    child.on("error", (error) => {
      finish(new RipgrepError(`ripgrep 启动失败: ${errorMessage(error)}`, "launch"));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (signal !== null) {
        reject(new RipgrepError(`搜索进程被信号 ${signal} 终止`, "failed"));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === 0 || code === 1) {
        resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), noMatches: code === 1 });
        return;
      }
      if (/regex parse error|error parsing glob/i.test(stderr)) {
        reject(new RipgrepError(`pattern/glob 被 ripgrep 拒绝: ${stderr}`, "invalid_pattern"));
        return;
      }
      reject(new RipgrepError(`ripgrep 执行失败（exit ${code}）${stderr ? `: ${stderr}` : ""}`, "failed"));
    });

    function finish(error: RipgrepError): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

export interface ParsedGrepOutput {
  matches: GrepMatch[];
  /** summary.stats.searches：rg 实际搜索的文件数（begin 记录只覆盖有输出的文件）。 */
  scannedFiles: number;
}

/**
 * 解析 `rg --json` NDJSON 输出。contextLines > 0 时依据 context 记录重建
 * 每个匹配的 before/after（夹在两个匹配之间的 context 行同时属于前一匹配的
 * after 与后一匹配的 before）。行按 (file, lineNumber) 排序保证确定性输出。
 */
export function parseGrepJsonOutput(stdout: string, contextLines: number): ParsedGrepOutput {
  const matches: GrepMatch[] = [];
  let scannedFiles = 0;
  let pendingBefore: string[] = [];
  let lastAfterBuffer: string[] | null = null;
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    let record: RipgrepJsonRecord;
    try {
      record = JSON.parse(raw) as RipgrepJsonRecord;
    } catch {
      throw new RipgrepError(`grep 收到畸形 ripgrep --json 输出（非 JSON 行）`, "failed");
    }
    if (record.type === "summary") {
      const searches = record.data?.stats?.searches;
      if (typeof searches === "number") scannedFiles = searches;
      continue;
    }
    if (record.type === "begin") {
      pendingBefore = [];
      lastAfterBuffer = null;
      continue;
    }
    if (record.type === "context") {
      const line = recordLineText(record);
      if (line === undefined) continue;
      pendingBefore.push(line);
      lastAfterBuffer?.push(line);
      continue;
    }
    if (record.type !== "match") continue; // end 及未来新增的记录类型属传输框架
    const line = recordLineText(record);
    if (line === undefined || typeof record.data?.line_number !== "number" || typeof record.data?.path?.text !== "string") {
      throw new RipgrepError(`grep 收到畸形 ripgrep --json 输出（match 记录缺字段）`, "failed");
    }
    const after: string[] = [];
    matches.push({
      file: normalizeRipgrepPath(record.data.path.text),
      line_number: record.data.line_number,
      line,
      before: contextLines > 0 ? pendingBefore.slice(-contextLines) : [],
      after,
    });
    lastAfterBuffer = after;
    pendingBefore = [];
  }
  // rg 在 --context=N 下，相距远的两个匹配之间会连续输出前一匹配的 N 行 after
  // 与后一匹配的 N 行 before；夹在中间的 context 行同时流进前一匹配的 after
  // 缓冲，故定稿时对 after 取前 N 行（即紧邻匹配的行），before 已在收集时截尾。
  if (contextLines > 0) {
    for (const match of matches) {
      if (match.after.length > contextLines) match.after = match.after.slice(0, contextLines);
    }
  }
  matches.sort((left, right) =>
    left.file === right.file ? left.line_number - right.line_number : left.file.localeCompare(right.file),
  );
  return { matches, scannedFiles };
}

/** rg --files 输出 → 归一化的根相对可移植路径列表。 */
export function parseGlobOutput(stdout: string): string[] {
  return stdout.split("\n").filter(Boolean).map(normalizeRipgrepPath);
}

/** rg 在 Windows 输出 `.\dir\file` / POSIX 输出 `./dir/file`；归一为 `dir/file`。 */
export function normalizeRipgrepPath(value: string): string {
  let normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function recordLineText(record: RipgrepJsonRecord): string | undefined {
  const lines = record.data?.lines;
  if (!lines || typeof lines !== "object") return undefined;
  if (typeof lines.text === "string") return lines.text.replace(/\r?\n$/, "");
  if (typeof lines.bytes === "string") return "(line is not valid UTF-8)";
  return undefined;
}

interface RipgrepJsonRecord {
  type?: string;
  data?: {
    path?: { text?: unknown };
    line_number?: unknown;
    lines?: { text?: unknown; bytes?: unknown };
    stats?: { searches?: unknown };
  } | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
