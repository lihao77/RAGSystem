import { Buffer } from "node:buffer";
import type { ChatMessage, ContentPart } from "@ragsystem/agent-llm";
import type { MessageContentPart } from "@ragsystem/agent-protocol";

import type { MessageInfo } from "../../../contracts/session/session.js";
import type { AttachmentReader } from "./extensions/types.js";

export async function projectCanonicalMessageContent(
  conversation: ChatMessage[],
  rawMessages: ReadonlyArray<MessageInfo | null>,
  options: {
    sessionId: string;
    supportsVision: boolean;
    readAttachment: AttachmentReader;
  },
): Promise<void> {
  for (const [index, message] of conversation.entries()) {
    const raw = rawMessages[index];
    if (!raw || raw.role !== message.role) continue;
    const textOverride = raw.role === "user" && typeof raw.metadata.expanded_task === "string"
      ? raw.metadata.expanded_task
      : null;
    message.content = await projectParts(raw.content_parts, raw.role, textOverride, options);
  }
}

async function projectParts(
  parts: readonly MessageContentPart[],
  role: MessageInfo["role"],
  textOverride: string | null,
  options: {
    sessionId: string;
    supportsVision: boolean;
    readAttachment: AttachmentReader;
  },
): Promise<ChatMessage["content"]> {
  const renderedText: string[] = [];
  const images: ContentPart[] = [];
  let insertedOverride = false;

  for (const part of parts) {
    if (part.type === "text") {
      if (textOverride !== null) {
        if (!insertedOverride) renderedText.push(textOverride);
        insertedOverride = true;
      } else {
        renderedText.push(part.text);
      }
      continue;
    }
    if (part.type === "file_ref") {
      if (role !== "assistant") continue;
      const caption = part.caption ? ` caption="${escapeXmlAttribute(part.caption)}"` : "";
      renderedText.push(`<file_ref path="${escapeXmlAttribute(part.file_path)}" presentation="${part.presentation}"${caption}/>`);
      continue;
    }
    if (role !== "user") continue;
    renderedText.push(renderAttachment(part));
    if (part.kind !== "image" || !options.supportsVision) continue;
    const source = await options.readAttachment(options.sessionId, part.file_id);
    if (!source) {
      renderedText.push(`[图片加载失败:${part.original_name}]`);
      continue;
    }
    const mime = normalizeImageMime(part.mime) ?? normalizeImageMime(source.contentType) ?? "image/png";
    images.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${Buffer.from(source.body).toString("base64")}`, detail: "auto" },
    });
  }

  if (textOverride !== null && !insertedOverride) renderedText.unshift(textOverride);
  const text = renderedText.join("\n");
  if (images.length === 0) return text;
  return [...(text ? [{ type: "text" as const, text }] : []), ...images];
}

function renderAttachment(part: Extract<MessageContentPart, { type: "attachment_ref" }>): string {
  const attributes = [
    `file_id="${escapeXmlAttribute(part.file_id)}"`,
    `name="${escapeXmlAttribute(part.original_name)}"`,
    `mime="${escapeXmlAttribute(part.mime || "application/octet-stream")}"`,
    `size="${part.size}"`,
    `kind="${part.kind}"`,
    `file_path="${escapeXmlAttribute(part.file_path ?? part.stored_name)}"`,
    `file_path_space="${part.file_path_space ?? "uploads"}"`,
  ];
  return `<attachments version="1"><attachment ${attributes.join(" ")}/></attachments>`;
}

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
