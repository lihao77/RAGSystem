import fs from "node:fs/promises";
import type { DocumentExtractor } from "../../../../contracts/knowledge/document-extractor.js";
import { normalizeMarkdown } from "../markdown-utils.js";

const PDF_MODULE = "unpdf";

export class PdfExtractor implements DocumentExtractor {
  async extract(input: Parameters<DocumentExtractor["extract"]>[0]): ReturnType<DocumentExtractor["extract"]> {
    const buffer = await fs.readFile(input.file_path);
    const { extractText } = await import(PDF_MODULE) as { extractText(data: Uint8Array): Promise<{ text: string[] }> };
    const result = await extractText(new Uint8Array(buffer));
    const text = result.text.join("\n\n").trim();
    if (!text) throw new Error("PDF 未提取到文本，扫描件或图片 PDF 需配置 MinerU 外挂");
    return { text, markdown: pdfTextToMarkdown(text), kind: "pdf" };
  }
}

function pdfTextToMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  const markdown = lines.map((rawLine) => {
    const line = rawLine.trimEnd();
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (inFence || !line.trim() || /^\s*(?:[-*+] |\d+[.)] )/.test(line)) return line;
    const trimmed = line.trim();
    if (isHeadingCandidate(trimmed)) return `## ${trimmed}`;
    return line;
  }).join("\n");
  return normalizeMarkdown(markdown);
}

function isHeadingCandidate(line: string): boolean {
  if (line.length === 0 || line.length > 60 || /[。！？.!?]$/.test(line)) return false;
  return /^\d+(?:[.、-]\d+)*[.、)\s]/.test(line) || /^[A-Z0-9][A-Z0-9 \-_:/]{2,}$/.test(line) || /^[一二三四五六七八九十]+[、.]/.test(line);
}
