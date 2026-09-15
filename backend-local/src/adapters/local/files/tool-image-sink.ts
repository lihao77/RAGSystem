/**
 * 工具图片持久化的本地实现：经 FileIndexService 存入会话附件通道（与用户上传同
 * 管线——持久、随会话清理、后续轮次投影可走 .variants 归一化缓存），并返回按
 * 默认请求策略归一化的字节供本轮 in-band 投影（编码可能与入参不同，如 png→webp）。
 * 原始字节原样落盘，请求变体由投影层读取时按需派生。
 *
 * 内容寻址去重（对齐 dsh 的幂等附件写入）：同会话内相同字节（如同一张工作区图
 * 被 view_image 多次查看）复用同一附件记录，不重复落盘。hash→file_id 索引持久在
 * uploads/.tool-images.json（随会话清理）；索引指向的附件被用户删除时回退为重新
 * 落盘并更新索引。并发写竞态下索引 last-write-wins，多余副本仅占磁盘，不影响正确性。
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ToolImagePersisted, ToolImageSink, ToolResultMedia } from "@ragsystem/agent-sdk";
import {
  DEFAULT_IMAGE_REQUEST_POLICY,
  type ImageRequestNormalizer,
  type ImageRequestNormalizerResult,
} from "@ragsystem/backend-core/contracts/images/image-request.js";
import type { FileIndexService } from "./file-index-service.js";

/** 从 mime 推导附件展示名的扩展名（FileIndexService.add 会再 sanitise 文件名）。 */
function extensionFor(mime: ToolResultMedia["mimeType"]): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

/** 展示名：带扩展名原样用；无扩展名按 mime 补（避免 icon.png.png）。 */
function displayName(input: { name?: string; toolName: string; mimeType: ToolResultMedia["mimeType"] }): string {
  const base = input.name?.trim() || `${input.toolName}-image`;
  return path.extname(base) ? base : base + extensionFor(input.mimeType);
}

async function writeAtomic(target: string, data: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

interface ToolImageIndex {
  /** sha256(bytes) → 附件 file_id。 */
  [hash: string]: string;
}

export class LocalToolImageSink implements ToolImageSink {
  /** 同 key 并发 save 去重（一批并发工具调用反复查看同一文件是真实场景）。 */
  private readonly inflight = new Map<string, Promise<ToolImagePersisted | null>>();

  constructor(
    private readonly files: FileIndexService,
    private readonly normalizer: ImageRequestNormalizer,
  ) {}

  async save(input: {
    bytes: Uint8Array;
    mimeType: ToolResultMedia["mimeType"];
    toolName: string;
    sessionId: string;
    name?: string;
  }): Promise<ToolImagePersisted | null> {
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    const mapKey = `${input.sessionId}\0${hash}`;
    const pending = this.inflight.get(mapKey) ?? this.saveOwned(input, hash);
    this.inflight.set(mapKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inflight.get(mapKey) === pending) this.inflight.delete(mapKey);
    }
  }

  private async saveOwned(
    input: { bytes: Uint8Array; mimeType: ToolResultMedia["mimeType"]; toolName: string; sessionId: string; name?: string },
    hash: string,
  ): Promise<ToolImagePersisted | null> {
    try {
      const record = await this.findExisting(input.sessionId, hash)
        ?? this.files.add({
          originalName: displayName(input),
          buffer: input.bytes,
          mime: input.mimeType,
          scopeType: "session",
          scopeId: input.sessionId,
        });
      await this.rememberHash(input.sessionId, hash, record.id);

      let adapted: ImageRequestNormalizerResult;
      try {
        adapted = await this.normalizer.normalize({
          data: input.bytes,
          mime: input.mimeType,
          policy: DEFAULT_IMAGE_REQUEST_POLICY,
        });
      } catch {
        adapted = { kind: "passthrough" };
      }
      if (adapted.kind === "normalized") {
        return {
          fileId: record.id,
          storedPath: record.stored_path,
          storedSize: input.bytes.byteLength,
          bytes: adapted.data,
          mimeType: adapted.mime,
        };
      }
      return {
        fileId: record.id,
        storedPath: record.stored_path,
        storedSize: input.bytes.byteLength,
        bytes: input.bytes,
        mimeType: input.mimeType,
      };
    } catch {
      // 持久化失败回退 SDK 临时文件通道，不阻断工具结果。
      return null;
    }
  }

  private indexDir(sessionId: string): string {
    return this.files.getSessionUploadsRoot(sessionId);
  }

  private indexPath(sessionId: string): string {
    return path.join(this.indexDir(sessionId), ".tool-images.json");
  }

  /** 命中且附件记录仍存活时复用；索引缺失/损坏一律按未命中收敛。 */
  private async findExisting(sessionId: string, hash: string): Promise<{ id: string; stored_path: string } | null> {
    try {
      const raw = await fs.readFile(this.indexPath(sessionId), "utf8");
      const index = JSON.parse(raw) as ToolImageIndex;
      const fileId = index[hash];
      if (!fileId) return null;
      const record = this.files.get(fileId, "session", sessionId);
      return record ? { id: record.id, stored_path: record.stored_path } : null;
    } catch {
      return null;
    }
  }

  private async rememberHash(sessionId: string, hash: string, fileId: string): Promise<void> {
    try {
      let index: ToolImageIndex = {};
      try {
        index = JSON.parse(await fs.readFile(this.indexPath(sessionId), "utf8")) as ToolImageIndex;
      } catch {
        // 缺失/损坏从空索引重建
      }
      if (index[hash] === fileId) return;
      index[hash] = fileId;
      await fs.mkdir(this.indexDir(sessionId), { recursive: true });
      await writeAtomic(this.indexPath(sessionId), `${JSON.stringify(index)}\n`);
    } catch {
      // 索引写失败只损失去重（下次重新落盘），不影响已返回的持久化结果。
    }
  }
}
