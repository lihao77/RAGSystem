import path from "node:path";

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  ".geojson": "application/geo+json",
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".markdown": "text/plain",
  ".log": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/**
 * 扩展名点必然是路径最后一个点，`path.extname` 在 win32（`\` 与 `/`）与 posix 上结果一致；
 * 输入可能是 Local 的绝对路径（含反斜杠）或 SaaS 的 `/`-only 相对路径，均可正确取到扩展名。
 */
export function inferMimeType(filePath: string): string {
  return EXTENSION_MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
