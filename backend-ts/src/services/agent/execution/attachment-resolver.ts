import type { AttachmentRef } from "../../../contracts/execution/execution.js";
import type { IFileIndexStore } from "../../../contracts/file-index-store/index.js";
import type { AsyncSessionFileStorage } from "../../../contracts/session/session-file-storage.js";

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
  constructor(
    private readonly fileIndex: IFileIndexStore | null = null,
    private readonly asyncStore: AsyncSessionFileStorage | null = null,
  ) {}

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

  /** Async deployment adapter used by SaaS object-storage backed uploads. */
  async resolveAsync(sessionId: string, attachments: AttachmentRef[]): Promise<AttachmentResolution> {
    if (!attachments.length) return { attachments: [] };
    if (this.asyncStore) {
      const resolved: ResolvedAttachment[] = [];
      for (const attachment of attachments) {
        const fileId = attachment.file_id.trim();
        if (!fileId) return { attachments: [], error: "附件 file_id 不能为空" };
        const record = await this.asyncStore.get(sessionId, fileId);
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
    return this.resolve(sessionId, attachments);
  }
}
