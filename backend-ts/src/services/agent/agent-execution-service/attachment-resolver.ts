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

export function appendAttachmentContext(task: string, attachments: ResolvedAttachment[]): string {
  if (!attachments.length) {
    return task;
  }
  const lines = ["[普通文件附件引用]"];
  for (const attachment of attachments) {
    lines.push(
      `- file_id=${attachment.file_id} | name=${attachment.original_name || attachment.stored_name || "attachment"} | mime=${attachment.mime || "unknown"} | size=${attachment.size} | file_path=${attachment.stored_path}`,
    );
  }
  const suffix = lines.join("\n");
  return task ? `${task}\n\n${suffix}` : suffix;
}
