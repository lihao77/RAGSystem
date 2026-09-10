import { structuredPatch } from "diff";

export interface ReadFileInput {
  filePath: string;
  encoding?: string | null;
  offset?: number | null;
  limit?: number | null;
  filePathSpace?: string | null;
}

export interface WriteFileInput {
  content: unknown;
  filePath?: string | null;
  encoding?: string | null;
  mode?: string | null;
  filePathSpace?: string | null;
}

export interface EditFileInput {
  filePath: string;
  oldString: string;
  newString: string;
  encoding?: string | null;
  replaceAll?: boolean | null;
  filePathSpace?: string | null;
}

export interface PreviewDataStructureInput {
  filePath: string;
  encoding?: string | null;
  maxPreviewRows?: number | null;
  maxDepth?: number | null;
  maxFields?: number | null;
  filePathSpace?: string | null;
}

/** 窗口内一行：1-based 文件行号、去换行文本、是否被单行截断。 */
export interface NumberedLine {
  number: number;
  text: string;
  truncated: boolean;
}

export interface LineSelection {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  nextOffset: number | null;
  /** 在行数上限之前因单次字符预算提前截断（少行超宽文件的防线）。 */
  charTruncated: boolean;
  /** 被按 READ_FILE_MAX_LINE_CHARS 截短的行数。 */
  truncatedLines: number;
  /** 行号化后的窗口行（渲染 content 的结构化来源）。 */
  numberedLines: NumberedLine[];
}

/** 是否为有行语义的文本编码（base64/hex 属二进制载荷，不做行窗口/行号化处理）。 */
export function isTextualEncoding(encoding: BufferEncoding): boolean {
  return encoding !== "base64" && encoding !== "hex";
}

export function normalizeEncoding(value: string | null | undefined): BufferEncoding {
  const encoding = value?.trim().toLowerCase() || "utf8";
  if (["utf8", "utf-8"].includes(encoding)) return "utf8";
  if (["utf16le", "utf-16le"].includes(encoding)) return "utf16le";
  if (["latin1", "binary"].includes(encoding)) return "latin1";
  if (encoding === "ascii") return "ascii";
  if (encoding === "base64") return "base64";
  if (encoding === "hex") return "hex";
  throw new Error(`不支持的编码: ${encoding}`);
}

export function normalizeReadRange(
  offset: number | null | undefined,
  limit: number | null | undefined,
  defaultLimit = 2_000,
  maxLimit = 10_000,
): { offset: number; limit: number } {
  const normalizedOffset = offset ?? 1;
  const normalizedLimit = limit ?? defaultLimit;
  if (!Number.isInteger(normalizedOffset) || normalizedOffset < 1) {
    throw new Error("offset 必须 >= 1");
  }
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > maxLimit) {
    throw new Error(`limit 必须在 1-${maxLimit} 之间`);
  }
  return { offset: normalizedOffset, limit: normalizedLimit };
}

export function normalizePreviewLimit(
  value: number | null | undefined,
  fallback: number,
  label: "max_preview_rows" | "max_depth" | "max_fields",
): number {
  if (value === null || value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} 必须 >= 1`);
  return value;
}

export function normalizeWriteMode(value: string | null | undefined): "text" | "json" {
  return value?.trim().toLowerCase() === "json" ? "json" : "text";
}

export function renderWritableContent(content: unknown, mode: "text" | "json"): string {
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
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  return String(content);
}

/* read_file 单次返回的字符预算：与 agent-sdk observation 的 inline 阈值对齐。
   行数分页拦不住"少行超宽"文件（minified JS、单行 JSON、base64），
   几行几十万字符会整文件灌进上下文，字符预算是第二道硬防线。 */
export const READ_FILE_CHAR_BUDGET = 16_000;
/* 单行截断上限：超长行截短到该长度，完整内容靠分页逐段读取。 */
export const READ_FILE_MAX_LINE_CHARS = 2_000;
/** 单行截断的尾部标注（对齐 dsh read-render：截断必须可见，不是静默变短）。 */
export const LINE_TRUNCATION_SUFFIX = "... (line truncated)";

/**
 * 窗口累积器（dsh buildWindow 的同步变体）：喂入"按 \n 切出的原始行"，
 * 在行数/单行/字符三层预算内产出窗口，同时精确计数文件总行数。
 * 预算只计行文本本身，不含渲染时加的行号前缀。
 */
interface LineWindowCollector {
  push(rawLine: string): void;
  finish(): LineSelection;
}

function createLineWindowCollector(
  offset: number,
  limit: number,
  budget: { charBudget?: number; maxLineChars?: number } = {},
): LineWindowCollector {
  const charBudget = Math.max(1, budget.charBudget ?? READ_FILE_CHAR_BUDGET);
  const maxLineChars = Math.max(1, budget.maxLineChars ?? READ_FILE_MAX_LINE_CHARS);
  let totalLines = 0;
  let usedChars = 0;
  let truncatedLines = 0;
  let charTruncated = false;
  let lastIncluded = 0; // 最后一个进入窗口的 1-based 行号；0 = 窗口为空
  const numberedLines: NumberedLine[] = [];

  return {
    push(rawLine: string): void {
      totalLines += 1;
      if (charTruncated || totalLines < offset || numberedLines.length >= limit) return;
      // CRLF 文件的行尾 \r 在窗口渲染中剥除（dsh stripCarriageReturn）。
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const remaining = charBudget - usedChars;
      if (remaining <= 0) {
        charTruncated = true;
        return;
      }
      let text = line;
      let truncated = false;
      const cap = Math.min(maxLineChars, remaining);
      if (text.length > cap) {
        text = `${text.slice(0, cap)}${LINE_TRUNCATION_SUFFIX}`;
        truncated = true;
        truncatedLines += 1;
      }
      numberedLines.push({ number: totalLines, text, truncated });
      usedChars += text.length;
      lastIncluded = totalLines;
    },
    finish(): LineSelection {
      const empty = numberedLines.length === 0;
      const endLine = empty ? offset - 1 : lastIncluded;
      const hasMore = !empty && lastIncluded < totalLines;
      return {
        content: "",
        totalLines,
        startLine: offset,
        endLine,
        hasMore,
        nextOffset: hasMore ? endLine + 1 : null,
        charTruncated,
        truncatedLines,
        numberedLines,
      };
    },
  };
}

/**
 * 把窗口渲染为模型可见文本：每行前缀 `行号: `（对齐 dsh/Claude Code 的行号化
 * 读取——行号是后续 edit_file/grep 定位的锚点），尾部附分页 footer。
 */
export function renderNumberedRead(selection: LineSelection): string {
  if (selection.numberedLines.length === 0) {
    return selection.totalLines === 0
      ? "(空文件)"
      : `(offset ${selection.startLine} 超出文件总行数 ${selection.totalLines})`;
  }
  const body = selection.numberedLines.map((line) => `${line.number}: ${line.text}`).join("\n");
  let footer: string;
  if (selection.charTruncated) {
    footer = `(本次受字符预算限制在第 ${selection.endLine} 行截断；继续读取用 offset=${selection.endLine + 1})`;
  } else if (selection.hasMore) {
    footer = `(第 ${selection.startLine}-${selection.endLine} 行，共 ${selection.totalLines} 行；继续读取用 offset=${selection.nextOffset})`;
  } else {
    footer = `(第 ${selection.startLine}-${selection.endLine} 行，已到文件末尾，共 ${selection.totalLines} 行)`;
  }
  return body ? `${body}\n\n${footer}` : footer;
}

/** 整段文本（已在内存中）的同步窗口选择——沙箱 wire 内容与 base64/hex 等整读编码用。 */
export function selectLineRange(
  content: string,
  offset: number,
  limit: number,
  budget: { charBudget?: number; maxLineChars?: number } = {},
): LineSelection {
  const collector = createLineWindowCollector(offset, limit, budget);
  let start = 0;
  for (;;) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) break;
    collector.push(content.slice(start, newline));
    start = newline + 1;
  }
  if (start < content.length) collector.push(content.slice(start));
  const selection = collector.finish();
  selection.content = renderNumberedRead(selection);
  return selection;
}

/**
 * 流式扫描文本块（对齐 dsh buildWindow：块边界无意义、当前行缓冲只留
 * maxLineChars+1 个字符——一个没有换行符的巨型行也不能让内存无界增长）。
 * 返回的 selection.content 已渲染行号化文本。
 */
export async function scanStreamWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  offset: number,
  limit: number,
  budget: { charBudget?: number; maxLineChars?: number } = {},
): Promise<LineSelection> {
  const maxLineChars = Math.max(1, budget.maxLineChars ?? READ_FILE_MAX_LINE_CHARS);
  // 截断点之外多留 2 个字符：1 个证明该行超长，1 个容纳完整行自带的行尾 \r。
  // 只有装下完整行的缓冲才剥 \r；被截断到上限的缓冲不剥，否则行中间的 \r 会被
  // 误吞成"恰好 2000 字符且未截断"（与 selectLineRange 的整行视角产生分歧）。
  const lineBufferCap = maxLineChars + 2;
  let lineBuffer = "";
  const appendToLineBuffer = (segment: string): void => {
    if (lineBuffer.length >= lineBufferCap) return;
    lineBuffer += segment;
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap);
  };

  const collector = createLineWindowCollector(offset, limit, budget);
  for await (const chunk of chunks) {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf("\n", start)) !== -1) {
      appendToLineBuffer(chunk.slice(start, newline));
      flushLine();
      start = newline + 1;
    }
    appendToLineBuffer(chunk.slice(start));
  }
  if (lineBuffer.length > 0) flushLine();
  const selection = collector.finish();
  selection.content = renderNumberedRead(selection);
  return selection;

  function flushLine(): void {
    const complete = lineBuffer.length < lineBufferCap;
    const rawLine = complete && lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer;
    collector.push(rawLine);
    lineBuffer = "";
  }
}

export function countOccurrences(content: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let index = 0;
  while (index <= content.length) {
    const found = content.indexOf(search, index);
    if (found === -1) break;
    count += 1;
    index = found + search.length;
  }
  return count;
}

/* ============================================================
 * 编辑匹配辅助（对齐 dsh：CRLF 归一匹配 + 多命中报行号）
 * ========================================================== */

/** CRLF→LF：edit/diff 的 canonical 内存形态（孤立 \r 不动）。 */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

/** 文件是否 CRLF 主导（决定编辑写回时是否整体还原 CRLF；混合行尾按 LF 写）。 */
export function crlfDominant(content: string): boolean {
  const crlf = countOccurrences(content, "\r\n");
  return crlf > 0 && crlf > countOccurrences(content, "\n") - crlf;
}

/** LF 文本整体还原为 CRLF。 */
export function restoreCrlf(content: string): string {
  return content.replaceAll("\n", "\r\n");
}

/** 在（已归一的）文本里找 search 的全部命中并返回各自 1-based 行号。 */
export function findMatchLineNumbers(content: string, search: string): number[] {
  if (!search) return [];
  const lines: number[] = [];
  let line = 1;
  let cursor = 0;
  let searchFrom = 0;
  for (;;) {
    const found = content.indexOf(search, searchFrom);
    if (found === -1) break;
    while (cursor < found) {
      if (content[cursor] === "\n") line += 1;
      cursor += 1;
    }
    lines.push(line);
    searchFrom = found + search.length;
  }
  return lines;
}

/**
 * 真 unified diff（npm diff 的 structuredPatch，dsh write/edit 展示层同款）：
 * 基于 LF 归一文本计算——CRLF 文件的编辑不得读成全文件改动；行首插入只产生
 * 一个 hunk 而不是"整文件都变了"。超 2000 字符截断。
 */
export function buildDiffPreview(before: string, after: string, fileName: string): string {
  if (before === after) return "";
  const patch = structuredPatch(
    `a/${fileName}`,
    `b/${fileName}`,
    normalizeLineEndings(before),
    normalizeLineEndings(after),
    undefined,
    undefined,
    { context: 1 },
  );
  // 标准 unified diff 头（--- a/x / +++ b/x）：前端 parseDiffPreviewText 靠 `+++ b/`
  // 提取文件名，裸 a/x、b/x 会被当成上下文行渲染成垃圾行。
  const output = [`--- ${patch.oldFileName}`, `+++ ${patch.newFileName}`];
  for (const hunk of patch.hunks) {
    output.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    output.push(...hunk.lines);
    if (output.join("\n").length > 2_000) {
      output.push("... [DIFF TRUNCATED]");
      break;
    }
  }
  return output.join("\n");
}
