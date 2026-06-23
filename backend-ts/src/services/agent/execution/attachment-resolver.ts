import type { AttachmentRef } from "../../../contracts/execution.js";
import type { IFileIndexStore } from "../../../contracts/file-index-store/index.js";

export interface ResolvedAttachment {
  file_id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  mime: string;
  size: number;
  kind: string;
}

export interface AttachmentResolution {
  attachments: ResolvedAttachment[];
  error?: string;
}

export class AttachmentResolver {
  constructor(private readonly fileIndex: IFileIndexStore | null = null) {}

  resolve(sessionId: string, attachments: AttachmentRef[]): AttachmentResolution {
    if (!attachments.length) {
      return { attachments: [] };
    }
    if (!this.fileIndex) {
      return { attachments: [], error: "Attachments are not supported by this TypeScript runtime instance" };
    }
    const resolved: ResolvedAttachment[] = [];
    for (const attachment of attachments) {
      const fileId = attachment.file_id.trim();
      if (!fileId) {
        return { attachments: [], error: "附件 file_id 不能为空" };
      }
      const record = this.fileIndex.get(fileId, "session", sessionId);
      if (!record) {
        return { attachments: [], error: `附件不存在或不属于当前会话: ${fileId}` };
      }
      resolved.push({
        file_id: record.id,
        original_name: record.original_name,
        stored_name: record.stored_name,
        stored_path: record.stored_path,
        mime: record.mime || attachment.mime || "",
        size: record.size,
        kind: attachment.kind ?? (record.mime.startsWith("image/") ? "image" : "file"),
      });
    }
    return { attachments: resolved };
  }
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 生成发给 LLM 的附件清单（属性式 XML），作为 user message content 的运行时上下文注入，
 * 仅 LLM 可见、不落库。无附件返回空串。
 */
export function formatAttachmentContext(attachments: ResolvedAttachment[]): string {
  if (!attachments.length) {
    return "";
  }
  const items = attachments.map((attachment) => {
    const attrs = [
      `file_id="${escapeXmlAttr(attachment.file_id)}"`,
      `name="${escapeXmlAttr(attachment.original_name || attachment.stored_name || "attachment")}"`,
      `mime="${escapeXmlAttr(attachment.mime || "unknown")}"`,
      `size="${escapeXmlAttr(String(attachment.size))}"`,
      `file_path="${escapeXmlAttr(attachment.stored_path)}"`,
    ];
    return `<attachment ${attrs.join(" ")}/>`;
  });
  return `<attachments>\n${items.join("\n")}\n</attachments>`;
}
