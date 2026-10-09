/** Formats accepted for inline conversation images; other image formats remain file attachments. */
export type InlineImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

const MIME_BY_EXTENSION: Readonly<Record<string, InlineImageMime>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};
const INLINE_MIMES = new Set<string>(Object.values(MIME_BY_EXTENSION));

/** A known unsupported extension or MIME must never be promoted by another metadata field. */
export function resolveInlineImageMime(mime: string | null | undefined, filename?: string | null): InlineImageMime | null {
  const normalized = (mime ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const basename = (filename ?? "").split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  const extension = dot >= 0 ? basename.slice(dot + 1).toLowerCase() : "";
  const expected = Object.hasOwn(MIME_BY_EXTENSION, extension) ? MIME_BY_EXTENSION[extension] : undefined;
  if (extension && !expected) return null;
  if (!normalized || normalized === "application/octet-stream") return expected ?? null;
  if (!INLINE_MIMES.has(normalized) || (expected && expected !== normalized)) return null;
  return normalized as InlineImageMime;
}

/** Check the actual encoding before constructing a model image request, including normalization fallbacks. */
export function detectInlineImageMime(bytes: Uint8Array): InlineImageMime | null {
  const startsWith = (signature: readonly number[]): boolean =>
    bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (bytes.length >= 12 && startsWith([0x52, 0x49, 0x46, 0x46])
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** Generic/missing content types may be inferred from bytes; explicit unsupported types may not. */
export function resolveInlineImageBytesMime(bytes: Uint8Array, mime?: string | null): InlineImageMime | null {
  const normalized = (mime ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized && normalized !== "application/octet-stream" && !INLINE_MIMES.has(normalized)) return null;
  return detectInlineImageMime(bytes);
}
