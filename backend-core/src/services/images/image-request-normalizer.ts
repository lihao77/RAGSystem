/**
 * 图片请求归一化的内核实现（契约见 contracts/images/image-request.ts）。
 * 纯字节变换、无持久化：local 与 SaaS 共用；变体缓存属部署存储形态，由各部署自备
 * （local 挂在会话 uploads 旁，见 backend-local 的 image-request-variants）。
 *
 * 管线参照 DeepSeek Harness 的两步预算：先按总像素等比缩小，再按长边上限收敛
 * 极端长宽比（均不放大）；EXIF 方向先应用（.rotate()）、统一转 sRGB、重编码即剥元数据。
 * 编码走质量阶梯（有 alpha → WebP，不透明 → JPEG，质量 85→75→60），取第一个进
 * 字节预算的输出；全超预算时保底取最小输出。原生解码经 FIFO 限流（并发 2），
 * 避免多图会话把进程打满。
 */

import sharp, { type Metadata } from "sharp";

import type {
  ImageRequestNormalizer,
  ImageRequestNormalizerResult,
  ImageRequestPolicy,
} from "../../contracts/images/image-request.js";

/** 阶梯间距刻意拉开：每降一档要换来一次实际的体积缩减（同 dsh 参考实现）。 */
const IMAGE_ENCODING_QUALITIES = [85, 75, 60] as const;
/**
 * lossy-WebP 的 effort 固定 0：更深的搜索多花 3-4 倍编码时间只省约 5% 体积。
 * 代价是 WebP 更容易落到低档甚至超出字节预算（保底取最小档），属有意取舍。
 */
const WEBP_ENCODING_EFFORT = 0;
const NORMALIZE_CONCURRENCY = 2;
/**
 * 绝对解码护栏：超限文件不做全量解码（10MB PNG 可编码上亿像素，FIFO 并发下
 * 内存峰值不可控），直接判 invalid 由调用方回退原字节。
 */
const MAX_DECODE_PIXELS = 100_000_000;

/** FIFO 限流器：原生图像转换并发受控，超出的排队等待。 */
class CompressionLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly concurrency: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1;
        const release = (): void => {
          this.active -= 1;
          this.waiting.shift()?.();
        };
        void Promise.resolve().then(task).then(
          (value) => {
            release();
            resolve(value);
          },
          (error: unknown) => {
            release();
            reject(error instanceof Error ? error : new Error("image normalization task failed", { cause: error }));
          },
        );
      };
      if (this.active < this.concurrency) start();
      else this.waiting.push(start);
    });
  }
}

const limiter = new CompressionLimiter(NORMALIZE_CONCURRENCY);

interface ProbedImage {
  format: string;
  /** EXIF 方向校正后的感知宽高（orientation ≥5 转置存储栅格）。 */
  width: number;
  height: number;
  animated: boolean;
  hasAlpha: boolean;
  orientation: number | undefined;
  /** 字节是否携带会随重编码剥除的描述性元数据（EXIF/XMP/ICC 等）。 */
  carriesMetadata: boolean;
  depth: string;
  space: string;
}

async function probe(data: Uint8Array): Promise<ProbedImage | null> {
  let metadata: Metadata;
  try {
    metadata = await sharp(data, { failOn: "error", limitInputPixels: false }).metadata();
  } catch {
    return null;
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) return null;
  const transposed = (metadata.orientation ?? 0) >= 5;
  const carriesMetadata = metadata.exif !== undefined
    || metadata.xmp !== undefined
    || metadata.iptc !== undefined
    || metadata.icc !== undefined
    || metadata.hasProfile === true
    || metadata.orientation !== undefined;
  return {
    format: metadata.format ?? "",
    width: transposed ? height : width,
    height: transposed ? width : height,
    animated: (metadata.pages ?? 1) > 1,
    hasAlpha: metadata.hasAlpha === true,
    orientation: metadata.orientation,
    carriesMetadata,
    depth: metadata.depth ?? "",
    space: metadata.space ?? "",
  };
}

/** 总像素预算 → 长边上限，两步等比收缩（不放大）。 */
function targetDimensions(
  source: { width: number; height: number },
  policy: ImageRequestPolicy,
): { width: number; height: number } {
  let width = source.width;
  let height = source.height;
  if (width * height > policy.maxPixels) {
    const scale = Math.sqrt(policy.maxPixels / (width * height));
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  const longEdge = Math.max(width, height);
  if (longEdge > policy.maxDimension) {
    const scale = policy.maxDimension / longEdge;
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  return { width, height };
}

/** 干净直通：单帧、无方向/元数据、8-bit sRGB、且三项预算全达标 → 原字节即请求字节。 */
function canPassThrough(detected: ProbedImage, bytes: number, policy: ImageRequestPolicy): boolean {
  return !detected.animated
    && !detected.carriesMetadata
    && detected.depth === "uchar"
    && detected.space === "srgb"
    && bytes <= policy.maxBytes
    && detected.width * detected.height <= policy.maxPixels
    && Math.max(detected.width, detected.height) <= policy.maxDimension;
}

export class CoreImageRequestNormalizer implements ImageRequestNormalizer {
  async normalize(input: {
    data: Uint8Array;
    mime: string;
    policy: ImageRequestPolicy;
  }): Promise<ImageRequestNormalizerResult> {
    if (input.data.byteLength === 0) return { kind: "invalid" };
    return limiter.run(() => this.normalizeOwned(input.data, input.policy));
  }

  private async normalizeOwned(
    data: Uint8Array,
    policy: ImageRequestPolicy,
  ): Promise<ImageRequestNormalizerResult> {
    const detected = await probe(data);
    if (!detected) return { kind: "invalid" };
    // GIF（含动图）与其他非栅格格式不重编码：动图会丢帧，调用方沿用原字节。
    if (detected.format !== "png" && detected.format !== "jpeg" && detected.format !== "webp") {
      return { kind: "passthrough" };
    }
    if (detected.animated) return { kind: "passthrough" };
    // 护栏在直通判定之前：策略像素预算（≤数百万）必然小于护栏，超护栏的图
    // 既不可能直通、也不能进入阶梯的解码路径。
    if (detected.width * detected.height > MAX_DECODE_PIXELS) return { kind: "invalid" };
    if (canPassThrough(detected, data.byteLength, policy)) return { kind: "passthrough" };

    const target = targetDimensions(detected, policy);
    const resized = target.width < detected.width || target.height < detected.height;
    const pipeline = sharp(data, { failOn: "error", limitInputPixels: false })
      .rotate()
      .toColourspace("srgb");
    const sized = resized
      ? pipeline.resize({ width: target.width, height: target.height, fit: "inside", withoutEnlargement: true })
      : pipeline;

    const mediaType = detected.hasAlpha ? ("image/webp" as const) : ("image/jpeg" as const);
    let smallest: { data: Uint8Array; width: number; height: number } | null = null;
    // 每档 clone() 独立重解码是刻意取舍（与 dsh 一致）：常规图首档即命中预算，
    // 只付一次解码；病态图最坏三次解码换实现简单与无中间态内存。若成为热点，
    // 可改为 raw 中间态一次解码多档编码（代价是 ~7MB/图的驻留内存）。
    for (const quality of IMAGE_ENCODING_QUALITIES) {
      const encoded = await (mediaType === "image/webp"
        ? sized.clone().webp({ quality, effort: WEBP_ENCODING_EFFORT })
        : sized.clone().jpeg({ quality })
      ).toBuffer({ resolveWithObject: true });
      const candidate = {
        data: new Uint8Array(encoded.data),
        width: encoded.info.width,
        height: encoded.info.height,
      };
      if (candidate.data.byteLength <= policy.maxBytes) {
        return {
          kind: "normalized",
          data: candidate.data,
          mime: mediaType,
          width: candidate.width,
          height: candidate.height,
          ...(resized ? { originalWidth: detected.width, originalHeight: detected.height } : {}),
        };
      }
      if (!smallest || candidate.data.byteLength < smallest.data.byteLength) smallest = candidate;
    }
    // 阶梯全超预算：保底取最小输出（预算外的极端图由调用方的硬上限兜底）。
    if (!smallest) return { kind: "invalid" };
    return {
      kind: "normalized",
      data: smallest.data,
      mime: mediaType,
      width: smallest.width,
      height: smallest.height,
      ...(resized ? { originalWidth: detected.width, originalHeight: detected.height } : {}),
    };
  }
}
