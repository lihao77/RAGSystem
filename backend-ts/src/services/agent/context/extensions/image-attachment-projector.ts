/**
 * image_attachment projector——把图片附件扩展投影成 ContentPart[](image_url 或降级文本占位)。
 *
 * 视觉门控(ctx.supportsVision):不支持 vision 时降级文本占位,避免厂商 API 400。
 * 读盘降级(ctx.readImage):读不到返回文本占位,不破坏对话。
 * 只产增量图片 parts;原 content 文本由 projectConversationExtensions.mergeParts 保留。
 */
import type { ContentPart } from "@ragsystem/agent-llm";
import type { ExtensionProjector } from "./types.js";
import { extractImageAttachments } from "../attachment-image.js";

export const imageAttachmentProjector: ExtensionProjector = {
  kind: "image_attachment",
  project(data, ctx) {
    const attachments = extractImageAttachments(data?.attachments);
    if (attachments.length === 0) return null;
    const parts: ContentPart[] = [];
    for (const att of attachments) {
      if (!ctx.supportsVision) {
        // 模型不支持 vision:降级文本占位,避免厂商 API 400
        parts.push({ type: "text", text: `[图片:${att.original_name ?? att.stored_path}(当前模型不支持图片识别)]` });
        continue;
      }
      const dataUrl = ctx.readImage(att.stored_path, att.mime);
      if (dataUrl) {
        parts.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
      } else {
        parts.push({ type: "text", text: `[图片加载失败:${att.original_name ?? att.stored_path}]` });
      }
    }
    return parts.length ? parts : null;
  },
};
