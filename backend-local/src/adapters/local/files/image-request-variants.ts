/**
 * 图片请求变体的会话级磁盘缓存（挂在会话 uploads 根下的 .variants/）。
 *
 * 情景：投影层每轮请求都重新读取会话附件图片，原始文件不可变（上传侧 delete+add
 * 生成新 file_id），但 linked_local 记录指向的本地文件可能被用户改动——所以缓存
 * 条目按源文件 stat（size+mtime）验效，不匹配即重新归一化，天然幂等。
 * 归一化判定为 passthrough/invalid 时也落一个"负缓存"条目，免去每轮的重复探测。
 * 所有失败一律返回 null（调用方回退原字节），绝不向上抛。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ImageRequestNormalizer,
  ImageRequestNormalizerResult,
  ImageRequestPolicy,
} from "@ragsystem/backend-core/contracts/images/image-request.js";
import type { UploadedFileRecord } from "@ragsystem/backend-core/contracts/storage/files.js";
import type { FileIndexService } from "./file-index-service.js";
interface VariantMeta {
  /** 生成该变体的归一化算法代次；不匹配即视为未命中重算（幂等收敛）。 */
  generator: string;
  kind: "normalized" | "passthrough" | "invalid";
  sourceSize: number;
  sourceMtimeMs: number;
  mime?: string;
  width?: number;
  height?: number;
  originalWidth?: number;
  originalHeight?: number;
}

/**
 * 变体生成算法代次。验效只看源文件 stat + 策略数字，无法感知"生成器代码变了"
 * （sharp 升级、质量阶梯/effort 调整、管线修 bug）——调整归一化产物语义时必须
 * 同步 bump 此值，让存量缓存自然失效换新键；旧条目成为无害孤儿，随会话清理。
 */
const VARIANT_GENERATION = "v1";

const VARIANT_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

/** 单附件删除时清理其全部变体与负缓存条目；失败静默（孤儿仅占磁盘，随会话清理）。 */
export async function removeFileVariants(uploadsRoot: string, fileId: string): Promise<void> {
  const dir = path.join(uploadsRoot, ".variants");
  try {
    const entries = await fs.readdir(dir);
    // 键形如 `${fileId}-v?-p...`，fileId 为不含 "-" 的 hex，前缀 `${fileId}-` 不会误伤其他附件。
    await Promise.all(
      entries
        .filter((name) => name.startsWith(`${fileId}-`))
        .map((name) => fs.rm(path.join(dir, name), { force: true })),
    );
  } catch {
    // 目录不存在等：无需清理
  }
}

/** 崩溃残留的临时写入按 mtime 清扫（超过 1 小时的 *.tmp）；失败静默。 */
async function sweepStaleTmp(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const cutoff = Date.now() - 60 * 60 * 1000;
    await Promise.all(entries.filter((name) => name.endsWith(".tmp")).map(async (name) => {
      const target = path.join(dir, name);
      try {
        const stats = await fs.stat(target);
        if (stats.mtimeMs < cutoff) await fs.rm(target, { force: true });
      } catch {
        // 与并发写入/删除竞态：跳过
      }
    }));
  } catch {
    // 目录不存在：无需清扫
  }
}

function variantExtension(mime: string): ".jpg" | ".webp" {
  return mime === "image/webp" ? ".webp" : ".jpg";
}

async function writeAtomic(target: string, data: Uint8Array | string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class ImageRequestVariantStore {
  private readonly inflight = new Map<string, Promise<{ body: Uint8Array; contentType: string } | null>>();

  constructor(
    private readonly files: FileIndexService,
    private readonly normalizer: ImageRequestNormalizer,
  ) {}

  /**
   * 读取（或生成并缓存）一条会话附件的图片请求变体。
   * @returns 归一化后的字节与 mime；null = 无变体可用（passthrough/invalid/失败），调用方用原字节。
   */
  async read(
    sessionId: string,
    record: UploadedFileRecord,
    storedPath: string,
    policy: ImageRequestPolicy,
  ): Promise<{ body: Uint8Array; contentType: string } | null> {
    const dir = path.join(this.files.getSessionUploadsRoot(sessionId), ".variants");
    const key = `${record.id}-v${VARIANT_GENERATION}-p${policy.maxPixels}-b${policy.maxBytes}-d${policy.maxDimension}`;
    // in-flight 键带上 sessionId：file_id 虽是随机 hex，跨会话碰撞时不得复用他人触发的生成。
    const mapKey = `${sessionId}\0${key}`;
    const pending = this.inflight.get(mapKey) ?? this.compute(dir, key, record, storedPath, policy);
    this.inflight.set(mapKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inflight.get(mapKey) === pending) this.inflight.delete(mapKey);
    }
  }

  private async compute(
    dir: string,
    key: string,
    record: UploadedFileRecord,
    storedPath: string,
    policy: ImageRequestPolicy,
  ): Promise<{ body: Uint8Array; contentType: string } | null> {
    try {
      const stats = await fs.stat(storedPath);
      if (!stats.isFile()) return null;
      const cached = await this.readCached(dir, key, stats.size, stats.mtimeMs);
      if (cached !== undefined) return cached;
      // 未命中时顺带清扫崩溃残留的过期 tmp（readdir 一次的成本，只在生成路径上付）。
      await sweepStaleTmp(dir);

      const data = new Uint8Array(await fs.readFile(storedPath));
      let result: ImageRequestNormalizerResult;
      try {
        result = await this.normalizer.normalize({ data, mime: record.mime, policy });
      } catch {
        result = { kind: "invalid" };
      }
      const meta: VariantMeta = {
        generator: VARIANT_GENERATION,
        kind: result.kind,
        sourceSize: stats.size,
        sourceMtimeMs: stats.mtimeMs,
      };
      if (result.kind === "normalized") {
        meta.mime = result.mime;
        meta.width = result.width;
        meta.height = result.height;
        if (result.originalWidth !== undefined && result.originalHeight !== undefined) {
          meta.originalWidth = result.originalWidth;
          meta.originalHeight = result.originalHeight;
        }
        await fs.mkdir(dir, { recursive: true });
        await writeAtomic(path.join(dir, `${key}${variantExtension(result.mime)}`), result.data);
      }
      await fs.mkdir(dir, { recursive: true });
      await writeAtomic(path.join(dir, `${key}.meta.json`), `${JSON.stringify(meta)}\n`);
      return result.kind === "normalized"
        ? { body: result.data, contentType: result.mime }
        : null;
    } catch {
      return null;
    }
  }

  /** 命中且源 stat 未变时返回变体（null=passthrough/invalid 负缓存）；未命中/失効返回 undefined。 */
  private async readCached(
    dir: string,
    key: string,
    sourceSize: number,
    sourceMtimeMs: number,
  ): Promise<{ body: Uint8Array; contentType: string } | null | undefined> {
    try {
      const raw = await fs.readFile(path.join(dir, `${key}.meta.json`), "utf8");
      const meta = JSON.parse(raw) as VariantMeta;
      if (meta.generator !== VARIANT_GENERATION) return undefined;
      if (meta.sourceSize !== sourceSize || meta.sourceMtimeMs !== sourceMtimeMs) return undefined;
      if (meta.kind !== "normalized") return null;
      const ext = variantExtension(meta.mime ?? "image/jpeg");
      const body = new Uint8Array(await fs.readFile(path.join(dir, `${key}${ext}`)));
      return { body, contentType: VARIANT_MIME_BY_EXT[ext] ?? "image/jpeg" };
    } catch {
      // 未命中、meta 损坏、变体字节缺失等一律按未命中处理，走重算收敛。
      return undefined;
    }
  }
}
