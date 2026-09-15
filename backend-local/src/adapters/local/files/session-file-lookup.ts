import fs from "node:fs";
import path from "node:path";

import type {
  SessionFileLookupPort,
  SessionFileReadOptions,
} from "@ragsystem/backend-core/contracts/session/session-file-storage.js";
import type { UploadedFileRecord } from "@ragsystem/backend-core/contracts/storage/files.js";
import type { FileIndexService } from "./file-index-service.js";
import type { ImageRequestVariantStore } from "./image-request-variants.js";

/** mime 缺失时也放行探测（normalizer 按字节嗅探格式，负缓存兜住重复成本）。 */
function isPossiblyImage(mime: string): boolean {
  return !mime.trim() || mime.trim().toLowerCase().startsWith("image/");
}

/** Promise-semantic session-file lookup over the local synchronous index. */
export class LocalSessionFileLookup implements SessionFileLookupPort {
  constructor(
    private readonly files: FileIndexService,
    private readonly imageVariants: ImageRequestVariantStore | null = null,
  ) {}

  async get(sessionId: string, fileId: string): Promise<UploadedFileRecord | null> {
    return this.files.get(fileId, "session", sessionId);
  }

  async read(
    sessionId: string,
    fileId: string,
    options?: SessionFileReadOptions,
  ): Promise<{ body: Uint8Array; contentType: string | null } | null> {
    const record = this.files.get(fileId, "session", sessionId);
    if (!record) return null;
    const storedPath = path.resolve(record.local_path ?? record.stored_path);
    if (record.storage_kind !== "linked_local") {
      const uploadsRoot = path.resolve(this.files.getSessionUploadsRoot(sessionId));
      const relative = path.relative(uploadsRoot, storedPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    }
    // 模型请求变体：原始文件保持不动，归一化结果由 variant store 缓存复用；
    // 未配置/不适用/失败时回退原字节（下载等路由始终走原字节路径）。
    if (options?.imageRequest && this.imageVariants && isPossiblyImage(record.mime)) {
      const variant = await this.imageVariants.read(sessionId, record, storedPath, options.imageRequest);
      if (variant) return variant;
    }
    try {
      return { body: await fs.promises.readFile(storedPath), contentType: record.mime || null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
