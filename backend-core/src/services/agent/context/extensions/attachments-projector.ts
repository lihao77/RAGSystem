import { Buffer } from "node:buffer";
import type { ContentPart } from "@ragsystem/agent-llm";
import { AttachmentsExtensionSchema, type MessageAttachment } from "@ragsystem/agent-protocol";

import type { ExtensionProjector } from "./types.js";

export function renderAttachmentsContext(items: readonly MessageAttachment[]): string {
  if (items.length === 0) return "";
  const lines = items.map((item) => {
    const attributes = [
      `file_id="${escapeXmlAttribute(item.file_id)}"`,
      `name="${escapeXmlAttribute(item.original_name)}"`,
      `mime="${escapeXmlAttribute(item.mime || "application/octet-stream")}"`,
      `size="${item.size}"`,
      `kind="${item.kind}"`,
      `file_path="${escapeXmlAttribute(item.stored_name)}"`,
      'file_path_space="uploads"',
    ];
    return `  <attachment ${attributes.join(" ")}/>`;
  });
  return `<attachments version="1">\n${lines.join("\n")}\n</attachments>`;
}

export const attachmentsProjector: ExtensionProjector = {
  kind: "attachments",
  async project(extension, ctx) {
    if (ctx.role !== "user") return null;
    const parsed = AttachmentsExtensionSchema.safeParse(extension);
    if (!parsed.success || parsed.data.data.items.length === 0) return null;
    const items = parsed.data.data.items;

    const context = renderAttachmentsContext(items);
    const images = items.filter((item) => item.kind === "image");
    if (images.length === 0 || !ctx.supportsVision) return context;

    const parts: ContentPart[] = [{ type: "text", text: context }];
    for (const item of images) {
      const source = await ctx.readAttachment(ctx.sessionId, item.file_id);
      if (!source) {
        parts.push({ type: "text", text: `[图片加载失败:${item.original_name}]` });
        continue;
      }
      const mime = normalizeImageMime(item.mime) ?? normalizeImageMime(source.contentType) ?? "image/png";
      const dataUrl = `data:${mime};base64,${Buffer.from(source.body).toString("base64")}`;
      parts.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
    }
    return parts;
  },
};

function normalizeImageMime(value: string | null | undefined): string | null {
  const mime = value?.trim();
  return mime && /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : null;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
