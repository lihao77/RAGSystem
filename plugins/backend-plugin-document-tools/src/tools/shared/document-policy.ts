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

export interface LineSelection {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  nextOffset: number | null;
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

export function selectLineRange(content: string, offset: number, limit: number): LineSelection {
  const allLines = splitPreservingLineEndings(content);
  const totalLines = allLines.length;
  const startIndex = offset - 1;
  const endIndex = Math.min(startIndex + limit, totalLines);
  if (startIndex >= totalLines) {
    return {
      content: "",
      totalLines,
      startLine: offset,
      endLine: offset,
      hasMore: false,
      nextOffset: null,
    };
  }
  const selectedLines = allLines.slice(startIndex, endIndex);
  const actualEndLine = startIndex + selectedLines.length;
  const hasMore = endIndex < totalLines;
  return {
    content: selectedLines.join("").replace(/\n+$/, ""),
    totalLines,
    startLine: offset,
    endLine: actualEndLine,
    hasMore,
    nextOffset: hasMore ? actualEndLine + 1 : null,
  };
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

export function buildDiffPreview(before: string, after: string, fileName: string): string {
  if (before === after) return "";
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const output = [`--- a/${fileName}`, `+++ b/${fileName}`];
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < maxLines; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) continue;
    output.push(`@@ line ${index + 1} @@`);
    if (beforeLine !== undefined) output.push(`-${beforeLine}`);
    if (afterLine !== undefined) output.push(`+${afterLine}`);
    if (output.join("\n").length > 2_000) {
      output.push("... [DIFF TRUNCATED]");
      break;
    }
  }
  return output.join("\n");
}

function splitPreservingLineEndings(content: string): string[] {
  if (!content) return [];
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
