import fs from "node:fs/promises";
import type { DocumentExtractor } from "../../../../contracts/knowledge/document-extractor.js";
import { htmlToMarkdown, markdownToText } from "../markdown-utils.js";

export class HtmlExtractor implements DocumentExtractor {
  async extract(input: Parameters<DocumentExtractor["extract"]>[0]): ReturnType<DocumentExtractor["extract"]> {
    const html = await fs.readFile(input.file_path, "utf8");
    const markdown = htmlToMarkdown(html);
    return { text: markdownToText(markdown), markdown, kind: "text" };
  }
}
