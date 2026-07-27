import type { ContentPart } from "@ragsystem/agent-llm";
import type { ExtensionProjector } from "./types.js";

interface StoredToolImage {
  stored_path: string;
  mime: string;
  kind: string;
  original_name?: string;
}

/** Restores persisted tool image references without storing base64 in SQLite. */
export const toolResultMediaProjector: ExtensionProjector = {
  kind: "tool_result_media",
  project(extension, ctx) {
    if (ctx.role !== "tool") return null;
    const media = extractToolImages(extension.data.media);
    const parts: ContentPart[] = [];
    for (const item of media) {
      if (!ctx.supportsVision) {
        parts.push({ type: "text", text: `[工具图片:${item.original_name ?? item.stored_path}(当前模型不支持图片识别)]` });
        continue;
      }
      const dataUrl = ctx.readToolImage(item.stored_path, item.mime);
      parts.push(dataUrl
        ? { type: "image_url", image_url: { url: dataUrl, detail: "auto" } }
        : { type: "text", text: `[工具图片已过期或加载失败:${item.original_name ?? item.stored_path}]` });
    }
    return parts.length ? parts : null;
  },
};

function extractToolImages(value: unknown): StoredToolImage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StoredToolImage => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as Record<string, unknown>;
    return record.kind === "image"
      && typeof record.stored_path === "string"
      && typeof record.mime === "string";
  });
}
