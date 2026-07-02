/**
 * 附件图片注入(context 组装层用,自 SDK context/attachment-image.ts 迁入)。
 *
 * 图片字节不入库——user message content 存纯文本,附件引用在 metadata.attachments。组装 LLM 消息时
 * (RecentMessagesContextSource.build,压缩视图之后),对 user 消息读盘转 base64 data URL,拼成
 * ContentPart[] 注入 content。读盘失败降级为文本占位,不破坏对话。
 */
import type { ChatMessage, ContentPart } from "@ragsystem/agent-llm";

/** 存储的图片附件最小结构(对齐 backend attachment 解析产物)。 */
export interface StoredImageAttachment {
  stored_path: string;
  mime: string;
  kind: string;
  original_name?: string;
}

/** 读图回调:stored_path → data URL;读不到返回 null(消费端实现,含 try/catch + base64 编码)。 */
export type ImageReader = (storedPath: string, mime: string) => string | null;

/** 从 metadata.attachments 提取 image 类型的附件。 */
export function extractImageAttachments(attachments: unknown): StoredImageAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter((a): a is StoredImageAttachment => {
    if (typeof a !== "object" || a === null) {
      return false;
    }
    const obj = a as Record<string, unknown>;
    return obj.kind === "image" && typeof obj.stored_path === "string";
  });
}

/**
 * 把 user 消息的纯文本 content + image attachments → 带 image part 的 ContentPart[](纯函数)。
 * 读盘经 readImage 回调(IO 与逻辑分离);失败的图片降级为文本占位 part;无图返回原 content。
 */
export function enrichUserMessageImages(
  content: string | ContentPart[],
  attachments: StoredImageAttachment[],
  readImage: ImageReader,
  supportsVision: boolean,
): string | ContentPart[] {
  if (attachments.length === 0) {
    return content;
  }
  const textPart =
    typeof content === "string"
      ? content
      : content.filter((p) => p.type === "text").map((p) => p.text).join("");
  const parts: ContentPart[] = [];
  if (textPart) {
    parts.push({ type: "text", text: textPart });
  }
  for (const att of attachments) {
    if (!supportsVision) {
      // 模型不支持 vision:降级为文本占位,模型知晓用户传了图但当前模型无法识别(避免厂商 API 400)。
      parts.push({ type: "text", text: `[图片:${att.original_name ?? att.stored_path}(当前模型不支持图片识别)]` });
      continue;
    }
    const dataUrl = readImage(att.stored_path, att.mime);
    if (dataUrl) {
      parts.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
    } else {
      parts.push({ type: "text", text: `[图片加载失败:${att.original_name ?? att.stored_path}]` });
    }
  }
  return parts;
}

/**
 * 按 user 消息序对齐,把 rawMessages 里 user 消息的图片附件注入 conversation 对应的 user ChatMessage。
 * messagesToConversation 对 user 消息 1:1 透传(仅 assistant 因 tool_calls 补占位),故 user 序严格对应。
 * 原地修改 conversation 的 user 消息 content。
 */
export function enrichConversationImages(
  conversation: ChatMessage[],
  rawMessages: ReadonlyArray<{ role: string; metadata: Record<string, unknown> }>,
  readImage: ImageReader,
  supportsVision: boolean,
): void {
  const userAttachments = rawMessages
    .filter((m) => m.role === "user")
    .map((m) => extractImageAttachments(m.metadata?.attachments));
  let userIdx = 0;
  for (const msg of conversation) {
    if (msg.role !== "user") {
      continue;
    }
    const atts = userAttachments[userIdx++] ?? [];
    if (atts.length === 0) {
      continue;
    }
    msg.content = enrichUserMessageImages(msg.content, atts, readImage, supportsVision);
  }
}
