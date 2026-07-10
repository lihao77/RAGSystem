import type { ContentPart } from "@ragsystem/agent-llm";
import type { ExtensionProjector } from "./types.js";
import { extractImageAttachments } from "../attachment-image.js";

/** Restores persisted tool image references without storing base64 in SQLite. */
export const toolResultMediaProjector: ExtensionProjector = {
  kind: "tool_result_media",
  project(data, ctx) {
    if (ctx.role !== "tool") return null;
    const media = extractImageAttachments(data.media);
    const parts: ContentPart[] = [];
    for (const item of media) {
      if (!ctx.supportsVision) {
        parts.push({ type: "text", text: `[工具图片:${item.original_name ?? item.stored_path}(当前模型不支持图片识别)]` });
        continue;
      }
      const dataUrl = (ctx.readToolImage ?? ctx.readImage)(item.stored_path, item.mime);
      parts.push(dataUrl
        ? { type: "image_url", image_url: { url: dataUrl, detail: "auto" } }
        : { type: "text", text: `[工具图片已过期或加载失败:${item.original_name ?? item.stored_path}]` });
    }
    return parts.length ? parts : null;
  },
};
