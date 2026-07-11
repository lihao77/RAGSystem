import fs from "node:fs/promises";
import type { DocumentExtractor } from "../../../../contracts/knowledge/document-extractor.js";

const DOCX_MODULE = "mammoth";

export class DocxExtractor implements DocumentExtractor {
  async extract(input: Parameters<DocumentExtractor["extract"]>[0]): ReturnType<DocumentExtractor["extract"]> {
    const buffer = await fs.readFile(input.file_path);
    const mammoth = await import(DOCX_MODULE) as { default: { extractRawText(input: { buffer: Buffer }): Promise<{ value: string }> } };
    const result = await mammoth.default.extractRawText({ buffer });
    return { text: result.value, kind: "docx" };
  }
}
