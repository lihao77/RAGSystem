import type { AttachmentRef } from "../../../contracts/execution/execution.js";
import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";
import type { MessageAttachment } from "@ragsystem/agent-protocol";

export interface AttachmentResolution {
  attachments: MessageAttachment[];
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
    const resolved: MessageAttachment[] = [];
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
        mime: record.mime || "",
        size: record.size,
        kind: record.mime.startsWith("image/") ? "image" : "file",
        ...(record.storage_kind === "linked_local" && record.local_path ? {
          file_path: record.local_path,
          file_path_space: "absolute" as const,
          ...(record.source_sha256 ? { content_sha256: record.source_sha256 } : {}),
        } : {}),
      });
    }
    return { attachments: resolved };
  }
}
