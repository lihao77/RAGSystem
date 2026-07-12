import fs from "node:fs/promises";
import type { DocumentExtractor } from "../../../../contracts/knowledge/document-extractor.js";
import { htmlToMarkdown, markdownToText } from "../markdown-utils.js";

const DOCX_MODULE = "mammoth";

export class DocxExtractor implements DocumentExtractor {
  async extract(input: Parameters<DocumentExtractor["extract"]>[0]): ReturnType<DocumentExtractor["extract"]> {
    const buffer = await fs.readFile(input.file_path);
    const mammoth = await import(DOCX_MODULE) as { default: { convertToHtml(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }> } };
    const result = await mammoth.default.convertToHtml({ buffer });
    if (result.messages.length > 0) console.warn("DOCX 转换包含提示", result.messages);
    const markdown = htmlToMarkdown(result.value);
    return { text: markdownToText(markdown), markdown, kind: "docx" };
  }
}
