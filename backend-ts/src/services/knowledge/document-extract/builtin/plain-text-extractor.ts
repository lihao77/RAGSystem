import fs from "node:fs/promises";
import path from "node:path";
import type { DocumentExtractor } from "../../../../contracts/knowledge/document-extractor.js";
import { normalizeMarkdown } from "../markdown-utils.js";

const CODE_LANGUAGES: Record<string, string> = { ".js": "javascript", ".jsx": "jsx", ".ts": "typescript", ".tsx": "tsx", ".py": "python", ".java": "java", ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".h": "c", ".hpp": "cpp", ".go": "go", ".rs": "rust", ".sh": "bash", ".ps1": "powershell", ".sql": "sql", ".xml": "xml", ".css": "css", ".json": "json", ".yaml": "yaml", ".yml": "yaml" };

export class PlainTextExtractor implements DocumentExtractor {
  async extract(input: Parameters<DocumentExtractor["extract"]>[0]): ReturnType<DocumentExtractor["extract"]> {
    const raw = await fs.readFile(input.file_path, "utf8");
    const extension = path.extname(input.file_name ?? input.file_path).toLowerCase();
    if (extension === ".md" || extension === ".markdown") {
      const markdown = normalizeMarkdown(raw);
      return { text: markdown, markdown, kind: "text" };
    }
    const language = CODE_LANGUAGES[extension];
    const markdown = language ? `\`\`\`${language}\n${raw.replace(/\r\n/g, "\n").trimEnd()}\n\`\`\`` : normalizeMarkdown(raw);
    return { text: raw, markdown, kind: "text" };
  }
}
