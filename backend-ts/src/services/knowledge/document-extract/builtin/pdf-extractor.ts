import fs from "node:fs/promises";
import type { DocumentExtractor } from "../../../../contracts/knowledge/document-extractor.js";

const PDF_MODULE = "unpdf";

export class PdfExtractor implements DocumentExtractor {
  async extract(input: Parameters<DocumentExtractor["extract"]>[0]): ReturnType<DocumentExtractor["extract"]> {
    const buffer = await fs.readFile(input.file_path);
    const { extractText } = await import(PDF_MODULE) as { extractText(data: Uint8Array): Promise<{ text: string[] }> };
    const result = await extractText(new Uint8Array(buffer));
    return { text: result.text.join("\n\n"), kind: "pdf" };
  }
}
