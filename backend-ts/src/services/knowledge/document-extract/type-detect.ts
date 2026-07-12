import fs from "node:fs";
import path from "node:path";
import type { ExtractInput, ExtractorKind } from "../../../contracts/knowledge/document-extractor.js";

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".yaml", ".yml", ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".go", ".rs", ".sh", ".ps1", ".sql", ".xml", ".css"]);

/** 文件类型按扩展名、魔数、MIME 依次判定。 */
export function detectExtractorKind(file: ExtractInput): ExtractorKind {
  const extension = path.extname(file.file_name ?? file.file_path).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (extension === ".docx") return "docx";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (TEXT_EXTENSIONS.has(extension)) return "text";

  const header = readHeader(file.file_path);
  if (header.subarray(0, 4).toString("ascii") === "%PDF") return "pdf";
  if (header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04) return "docx";
  if (header.length >= 4 && header[0] === 0xd0 && header[1] === 0xcf && header[2] === 0x11 && header[3] === 0xe0) return "unknown";

  const mime = file.mime?.toLowerCase() ?? "";
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("wordprocessingml.document")) return "docx";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("yaml") || mime.includes("xml")) return "text";
  return "unknown";
}

function readHeader(filePath: string): Buffer {
  const file = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(8);
    const bytesRead = fs.readSync(file, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(file);
  }
}
