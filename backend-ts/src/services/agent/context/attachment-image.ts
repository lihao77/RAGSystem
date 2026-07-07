/**
 * 附件图片投影原语(image_attachment projector 用)。
 *
 * 图片字节不入库——user message content 存纯文本,图片引用挂在 metadata.extensions[image_attachment]。
 * 组装 LLM 消息时(recent-source,压缩视图之后),image_attachment projector 读盘转 base64 data URL,
 * 拼成 ContentPart[] 注入 content;读盘失败/模型不支持 vision 降级文本占位,不破坏对话。
 */

/** 存储的图片附件最小结构(对齐 backend attachment 解析产物)。 */
export interface StoredImageAttachment {
  stored_path: string;
  mime: string;
  kind: string;
  original_name?: string;
}

/** 读图回调:stored_path → data URL;读不到返回 null(消费端实现,含 try/catch + base64 编码)。 */
export type ImageReader = (storedPath: string, mime: string) => string | null;

/** 从 extensions[image_attachment].data.attachments 提取 image 类型的附件。 */
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
