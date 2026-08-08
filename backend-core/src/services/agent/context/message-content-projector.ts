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
    message.content = await projectParts(raw.content_parts, raw.role, options);
  }
}

export function hasAgentVisibleMessageContent(
  parts: readonly MessageContentPart[],
  role: MessageInfo["role"],
): boolean {
  return parts.some((part) => {
    if (part.type === "text") return part.text.length > 0;
    if (part.type === "file_ref") return role === "assistant";
    if (part.type === "attachment_ref") return role === "user";
    if (part.type === "command_ref") {
      return role === "user" && part.resolution.kind === "prompt";
    }
    return false;
  });
}

export function resolveAgentTaskText(parts: readonly MessageContentPart[], fallback: string): string {
  const rendered = parts.flatMap((part): string[] => {
    if (part.type === "text") return [part.text];
    if (part.type === "command_ref" && part.resolution.kind === "prompt") {
      return [part.resolution.agent_text];
    }
    return [];
  }).join("\n").trim();
  return rendered || fallback;
}

async function projectParts(
  parts: readonly MessageContentPart[],
  role: MessageInfo["role"],
  options: {
    sessionId: string;
    supportsVision: boolean;
    readAttachment: AttachmentReader;
  },
): Promise<ChatMessage["content"]> {
  const renderedText: string[] = [];
  const images: ContentPart[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      renderedText.push(part.text);
      continue;
    }
    if (part.type === "file_ref") {
      if (role !== "assistant") continue;
      const caption = part.caption ? ` caption="${escapeXmlAttribute(part.caption)}"` : "";
      renderedText.push(`<file_ref path="${escapeXmlAttribute(part.file_path)}" presentation="${part.presentation}"${caption}/>`);
      continue;
    }
    if (part.type === "command_ref") {
      if (role === "user" && part.resolution.kind === "prompt") {
        renderedText.push(part.resolution.agent_text);
      }
      continue;
    }
    if (part.type === "attachment_ref") {
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
  }

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
