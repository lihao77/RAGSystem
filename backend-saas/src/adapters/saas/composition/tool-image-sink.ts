/**
 * 工具图片持久化的 SaaS 实现：经对象存储会话附件通道落盘（与用户上传同管线），
 * 返回按默认请求策略归一化的字节供本轮 in-band 投影。与 LocalToolImageSink 同构，
 * 仅存储基座不同。
 *
 * 内容寻址去重：无本地文件系统，hash→file_id 只做进程内会话级索引；跨实例/重启
 * 后退化为重新落盘一份副本（仅多占存储，正确性不受影响）。
 */

import { createHash } from "node:crypto";

import type { ToolImagePersisted, ToolImageSink, ToolResultMedia } from "@ragsystem/agent-sdk";
import path from "node:path";
import {
  DEFAULT_IMAGE_REQUEST_POLICY,
  type ImageRequestNormalizer,
  type ImageRequestNormalizerResult,
} from "@ragsystem/backend-core/contracts/images/image-request.js";
import { CoreImageRequestNormalizer } from "@ragsystem/backend-core/services/images/image-request-normalizer.js";
import type { AsyncSessionFileStorage } from "@ragsystem/backend-core/contracts/session/session-file-storage.js";

/** 从 mime 推导附件展示名的扩展名（SaaS add 会再 sanitise 文件名）。 */
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

export class SaaSToolImageSink implements ToolImageSink {
  private readonly normalizer: ImageRequestNormalizer = new CoreImageRequestNormalizer();
  /** `${sessionId}\0${sha256}` → 附件引用；进程内去重（跨实例/重启退化，见文件头注释）。 */
  private readonly dedupe = new Map<string, { fileId: string; storedPath: string }>();
  /** 同 key 并发 save 去重（一批并发工具调用反复查看同一文件是真实场景）。 */
  private readonly inflight = new Map<string, Promise<ToolImagePersisted | null>>();
  /** 缓存必须有界：超限整体清空退化为重落盘（与跨实例语义一致，仅多占存储）。 */
  private static readonly DEDUPE_MAX_ENTRIES = 8192;

  constructor(private readonly storage: AsyncSessionFileStorage) {}

  async save(input: {
    bytes: Uint8Array;
    mimeType: ToolResultMedia["mimeType"];
    toolName: string;
    sessionId: string;
    name?: string;
  }): Promise<ToolImagePersisted | null> {
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    const mapKey = `${input.sessionId}\0${hash}`;
    const pending = this.inflight.get(mapKey) ?? this.saveOwned(input, hash, mapKey);
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
    mapKey: string,
  ): Promise<ToolImagePersisted | null> {
    try {
      const cached = this.dedupe.get(mapKey);
      let record: { fileId: string; storedPath: string };
      if (cached && await this.storage.get(input.sessionId, cached.fileId)) {
        record = cached;
      } else {
        const created = await this.storage.add(input.sessionId, {
          originalName: displayName(input),
          buffer: input.bytes,
          mime: input.mimeType,
        });
        record = { fileId: created.id, storedPath: created.stored_path };
        if (this.dedupe.size >= SaaSToolImageSink.DEDUPE_MAX_ENTRIES) this.dedupe.clear();
        this.dedupe.set(mapKey, record);
      }

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
          fileId: record.fileId,
          storedPath: record.storedPath,
          storedSize: input.bytes.byteLength,
          bytes: adapted.data,
          mimeType: adapted.mime,
        };
      }
      return {
        fileId: record.fileId,
        storedPath: record.storedPath,
        storedSize: input.bytes.byteLength,
        bytes: input.bytes,
        mimeType: input.mimeType,
      };
    } catch {
      // 持久化失败回退 SDK 临时文件通道，不阻断工具结果。
      return null;
    }
  }
}
