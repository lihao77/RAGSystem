/**
 * 图片请求归一化契约：把发往模型的图片字节在客户端归一到统一预算
 * （EXIF 方向校正、剥元数据、转 sRGB、像素/长边/字节预算、质量阶梯重编码）。
 * 契约与默认预算在 core；实现由部署提供（local 基于 sharp），插件经
 * IMAGE_REQUEST_NORMALIZER_CAPABILITY 消费，未提供时回退原字节行为。
 */

import { createCapability } from "../../plugins/capability-registry.js";

/** 客户端归一化预算；对齐主流服务商的服务端归一化（如 Anthropic 建议长边 ≤1568px）。 */
export interface ImageRequestPolicy {
  /** 解码总像素预算；超预算等比缩小（不放大）。 */
  maxPixels: number;
  /** 长边像素上限；总像素达标后再按它收敛极端长宽比。 */
  maxDimension: number;
  /** 编码字节目标；质量阶梯全超时保底取最小输出。 */
  maxBytes: number;
}

export const DEFAULT_IMAGE_REQUEST_POLICY: ImageRequestPolicy = Object.freeze({
  maxPixels: 2_460_000,
  maxDimension: 1568,
  maxBytes: 1024 * 1024,
});

/** 归一化输出尺寸（kind="normalized" 时携带）。 */
export interface NormalizedImageShape {
  data: Uint8Array;
  mime: "image/jpeg" | "image/webp";
  width: number;
  height: number;
  /** 归一化前的方向校正尺寸；仅在像素被缩小时携带（供坐标换算提示）。 */
  originalWidth?: number;
  originalHeight?: number;
}

export type ImageRequestNormalizerResult =
  | { kind: "passthrough" }
  | ({ kind: "normalized" } & NormalizedImageShape)
  | { kind: "invalid" };

export interface ImageRequestNormalizer {
  /**
   * 归一化一段图片字节。passthrough = 原字节已满足预算（或属保留原样的格式，
   * 如动图），调用方直接用原字节；invalid = 无法解码，调用方决定回退或报错。
   */
  normalize(input: {
    data: Uint8Array;
    mime: string;
    policy: ImageRequestPolicy;
  }): Promise<ImageRequestNormalizerResult>;
}

export const IMAGE_REQUEST_NORMALIZER_CAPABILITY = createCapability<ImageRequestNormalizer>(
  "image_request_normalizer",
);
