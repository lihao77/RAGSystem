import fs from "node:fs/promises";
import path from "node:path";
import type { DocumentExtractor } from "../../../../contracts/knowledge/document-extractor.js";

export class PlainTextExtractor implements DocumentExtractor {
  async extract(input: Parameters<DocumentExtractor["extract"]>[0]): ReturnType<DocumentExtractor["extract"]> {
    const raw = await fs.readFile(input.file_path, "utf8");
    const extension = path.extname(input.file_name ?? input.file_path).toLowerCase();
    const text = extension === ".html" || extension === ".htm" ? stripHtml(raw) : raw;
    return { text, kind: "text" };
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}
