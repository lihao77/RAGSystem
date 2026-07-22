import type { AttachmentRef } from "../../../contracts/execution/execution.js";
import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";

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
  constructor(private readonly files: SessionFileLookupPort | null = null) {}

  async resolve(sessionId: string, attachments: AttachmentRef[]): Promise<AttachmentResolution> {
    if (!attachments.length) {
      return { attachments: [] };
    }
    if (!this.files) {
      return { attachments: [], error: "Attachments are not supported by this TypeScript runtime instance" };
    }
    const resolved: ResolvedAttachment[] = [];
    for (const attachment of attachments) {
      const fileId = attachment.file_id.trim();
      if (!fileId) {
        return { attachments: [], error: "附件 file_id 不能为空" };
      }
      const record = await this.files.get(sessionId, fileId);
      if (!record) return { attachments: [], error: `附件不存在或不属于当前会话: ${fileId}` };
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
