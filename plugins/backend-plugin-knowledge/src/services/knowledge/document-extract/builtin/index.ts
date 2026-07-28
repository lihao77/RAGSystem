import type { DocumentExtractor, ExtractorKind } from "../../../../contracts/knowledge/document-extractor.js";
import { DocxExtractor } from "./docx-extractor.js";
import { HtmlExtractor } from "./html-extractor.js";
import { PdfExtractor } from "./pdf-extractor.js";
import { PlainTextExtractor } from "./plain-text-extractor.js";

const BUILTIN_EXTRACTORS = new Map<ExtractorKind, DocumentExtractor>([
  ["text", new PlainTextExtractor()],
  ["html", new HtmlExtractor()],
  ["pdf", new PdfExtractor()],
  ["docx", new DocxExtractor()],
]);

export function getBuiltinExtractor(kind: ExtractorKind): DocumentExtractor | null {
  return BUILTIN_EXTRACTORS.get(kind) ?? null;
}
