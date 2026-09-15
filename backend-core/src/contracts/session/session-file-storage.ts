import type { UploadedFileRecord } from "../storage/files.js";
import type { ImageRequestPolicy } from "../images/image-request.js";

export interface AddSessionFileMetadataInput extends UploadedFileRecord {
  tenant_id: string;
}

export interface SessionFileMetadata extends UploadedFileRecord {
  tenant_id: string;
}

export interface SessionFileMetadataRepository {
  list(tenantId: string, sessionId: string): Promise<SessionFileMetadata[]>;
  get(tenantId: string, sessionId: string, fileId: string): Promise<SessionFileMetadata | null>;
  create(input: AddSessionFileMetadataInput): Promise<SessionFileMetadata>;
  delete(tenantId: string, sessionId: string, fileId: string): Promise<boolean>;
}

export interface AsyncSessionFileStorage {
  list(sessionId: string): Promise<UploadedFileRecord[]>;
  get(sessionId: string, fileId: string): Promise<UploadedFileRecord | null>;
  add(sessionId: string, input: { originalName: string; buffer: Uint8Array; mime: string }): Promise<UploadedFileRecord>;
  delete(sessionId: string, fileId: string): Promise<UploadedFileRecord | null>;
  read(sessionId: string, fileId: string): Promise<{ body: Uint8Array; contentType: string | null } | null>;
}

/**
 * 附件读取选项：携带 imageRequest 时，部署可返回按预算归一化的图片请求变体
 * （无实现或归一化不适用时返回原字节）。原始文件不受影响，下载仍走原字节。
 */
export interface SessionFileReadOptions {
  imageRequest?: ImageRequestPolicy;
}

/**
 * Deployment-neutral asynchronous lookup used by agent attachment resolution.
 * 实现契约：返回的 contentType 必须与 body 的实际编码一致（归一化变体可能换编码，
 * 如 png→jpeg/webp）——投影层据此构造 data URL，实现方不得回填占位 mime。
 */
export interface SessionFileLookupPort {
  get(sessionId: string, fileId: string): Promise<UploadedFileRecord | null>;
  read(
    sessionId: string,
    fileId: string,
    options?: SessionFileReadOptions,
  ): Promise<{ body: Uint8Array; contentType: string | null } | null>;
}
