import type { MediaAdapterId } from "./provider-types.js";

export type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
export type ImageResolutionTier = "1k" | "2k" | "4k";
export type VideoResolution = "720p" | "1080p";

export const ALL_ASPECT_RATIOS: readonly AspectRatio[] = ["1:1", "16:9", "9:16", "4:3", "3:4"];
export const ALL_IMAGE_TIERS: readonly ImageResolutionTier[] = ["1k", "2k", "4k"];
export const ALL_VIDEO_RESOLUTIONS: readonly VideoResolution[] = ["720p", "1080p"];

export interface ImageCaps {
  kind: "image";
  aspectRatios: readonly AspectRatio[];
  resolutionTiers: readonly ImageResolutionTier[];
  /** 参考图（图生图/编辑）上限；0 = 纯文生图。 */
  maxRefImages: number;
  /** 单次请求可生成的张数上限。 */
  maxBatch: number;
}

export interface VideoCaps {
  kind: "video";
  aspectRatios: readonly AspectRatio[];
  resolutions: readonly VideoResolution[];
  minDurationSeconds: number;
  maxDurationSeconds: number;
  /** 时长步进（非整倍数时夹到最近步进）。 */
  stepSeconds: number;
  supportsAudio: boolean;
  supportsFirstFrame: boolean;
  supportsLastFrame: boolean;
}

export type ModelCaps = ImageCaps | VideoCaps;

export interface CatalogModelEntry {
  id: string;
  adapter: MediaAdapterId;
  kind: "image" | "video";
  /** 目录 label（含厂商与参考价；仅供文档/测试参考，设置页不再下拉）。 */
  label: string;
  caps: ModelCaps;
}

const STANDARD_IMAGE_RATIOS: readonly AspectRatio[] = ["1:1", "16:9", "9:16", "4:3", "3:4"];

/**
 * 内置生成模型目录（价格随官方调整，以厂商价格页为准）。
 * 模型名可填目录外新模型，能力按 adapter 默认 caps 处理。
 */
export const MODEL_CATALOG: readonly CatalogModelEntry[] = [
  /* ── 智谱 ── */
  {
    id: "glm-image",
    adapter: "zhipu",
    kind: "image",
    label: "glm-image（智谱·约0.1元/张）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k", "2k"],
      maxRefImages: 0,
      maxBatch: 4,
    },
  },
  {
    id: "cogvideox-3",
    adapter: "zhipu",
    kind: "video",
    label: "cogvideox-3（智谱·1元/次，720p-4K，5/10秒）",
    caps: {
      kind: "video",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutions: ["720p", "1080p"],
      minDurationSeconds: 5,
      maxDurationSeconds: 10,
      stepSeconds: 5,
      supportsAudio: true,
      supportsFirstFrame: true,
      supportsLastFrame: true,
    },
  },
  /* ── 火山方舟 ── */
  {
    id: "doubao-seedream-5-0-pro",
    adapter: "volcengine",
    kind: "image",
    label: "doubao-seedream-5-0-pro（火山·0.3-0.6元/张，参考图10张）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k", "2k", "4k"],
      maxRefImages: 10,
      maxBatch: 4,
    },
  },
  {
    id: "doubao-seedream-5-0-lite",
    adapter: "volcengine",
    kind: "image",
    label: "doubao-seedream-5-0-lite（火山·约0.22元/张）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k", "2k", "4k"],
      maxRefImages: 14,
      maxBatch: 4,
    },
  },
  {
    id: "doubao-seedream-4-0",
    adapter: "volcengine",
    kind: "image",
    label: "doubao-seedream-4-0（火山·约0.2元/张）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k", "2k"],
      maxRefImages: 1,
      maxBatch: 4,
    },
  },
  {
    id: "doubao-seedance-2-0",
    adapter: "volcengine",
    kind: "video",
    label: "doubao-seedance-2-0（火山·720p约1元/秒，4-15秒）",
    caps: {
      kind: "video",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutions: ["720p", "1080p"],
      minDurationSeconds: 4,
      maxDurationSeconds: 15,
      stepSeconds: 1,
      supportsAudio: true,
      supportsFirstFrame: true,
      supportsLastFrame: true,
    },
  },
  {
    id: "doubao-seedance-2-0-mini",
    adapter: "volcengine",
    kind: "video",
    label: "doubao-seedance-2-0-mini（火山·720p约0.5元/秒）",
    caps: {
      kind: "video",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutions: ["720p"],
      minDurationSeconds: 4,
      maxDurationSeconds: 15,
      stepSeconds: 1,
      supportsAudio: true,
      supportsFirstFrame: true,
      supportsLastFrame: true,
    },
  },
  /* ── 阿里百炼 ── */
  {
    id: "wan2.7-image-pro",
    adapter: "dashscope",
    kind: "image",
    label: "wan2.7-image-pro（百炼·支持4K与多图参考）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k", "2k", "4k"],
      maxRefImages: 9,
      maxBatch: 4,
    },
  },
  {
    id: "wan2.7-image",
    adapter: "dashscope",
    kind: "image",
    label: "wan2.7-image（百炼·快档，2K）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k", "2k"],
      maxRefImages: 9,
      maxBatch: 4,
    },
  },
  {
    id: "wan2.7-t2v",
    adapter: "dashscope",
    kind: "video",
    label: "wan2.7-t2v（百炼·720p约0.6元/秒，2-15秒）",
    caps: {
      kind: "video",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutions: ["720p", "1080p"],
      minDurationSeconds: 2,
      maxDurationSeconds: 15,
      stepSeconds: 1,
      supportsAudio: true,
      supportsFirstFrame: false,
      supportsLastFrame: false,
    },
  },
  {
    id: "wan2.7-i2v",
    adapter: "dashscope",
    kind: "video",
    label: "wan2.7-i2v（百炼·图生视频，720p约0.6元/秒）",
    caps: {
      kind: "video",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutions: ["720p", "1080p"],
      minDurationSeconds: 2,
      maxDurationSeconds: 15,
      stepSeconds: 1,
      supportsAudio: true,
      supportsFirstFrame: true,
      supportsLastFrame: true,
    },
  },
  {
    id: "wan2.6-i2v-flash",
    adapter: "dashscope",
    kind: "video",
    label: "wan2.6-i2v-flash（百炼·无声720p约0.15元/秒）",
    caps: {
      kind: "video",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutions: ["720p", "1080p"],
      minDurationSeconds: 2,
      maxDurationSeconds: 15,
      stepSeconds: 1,
      supportsAudio: false,
      supportsFirstFrame: true,
      supportsLastFrame: true,
    },
  },
  /* ── 魔搭社区（ModelScope API-Inference，仅生图；官方未开放视频 API） ── */
  {
    id: "Qwen/Qwen-Image",
    adapter: "modelscope",
    kind: "image",
    label: "Qwen/Qwen-Image（魔搭·免费额度，单边≤1664px，支持编辑参考图）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k"],
      maxRefImages: 3,
      maxBatch: 4,
    },
  },
  {
    id: "Tongyi-MAI/Z-Image-Turbo",
    adapter: "modelscope",
    kind: "image",
    label: "Tongyi-MAI/Z-Image-Turbo（魔搭·免费额度快档，单边≤2048px）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k", "2k"],
      maxRefImages: 0,
      maxBatch: 4,
    },
  },
  /* ── OpenAI ── */
  {
    id: "gpt-image-1",
    adapter: "openai",
    kind: "image",
    label: "gpt-image-1（OpenAI·约$0.04-0.19/张，需海外网络）",
    caps: {
      kind: "image",
      aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      resolutionTiers: ["1k"],
      maxRefImages: 16,
      maxBatch: 4,
    },
  },
  {
    id: "gpt-image-1-mini",
    adapter: "openai",
    kind: "image",
    label: "gpt-image-1-mini（OpenAI·约$0.01-0.04/张）",
    caps: {
      kind: "image",
      aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      resolutionTiers: ["1k"],
      maxRefImages: 16,
      maxBatch: 4,
    },
  },
  {
    id: "sora-2",
    adapter: "openai",
    kind: "video",
    label: "sora-2（OpenAI·720p $0.10/秒，8/16/20秒）",
    caps: {
      kind: "video",
      aspectRatios: ["16:9", "9:16"],
      resolutions: ["720p"],
      minDurationSeconds: 8,
      maxDurationSeconds: 20,
      stepSeconds: 4,
      supportsAudio: true,
      supportsFirstFrame: true,
      supportsLastFrame: false,
    },
  },
  {
    id: "sora-2-pro",
    adapter: "openai",
    kind: "video",
    label: "sora-2-pro（OpenAI·至1080p $0.3-0.7/秒）",
    caps: {
      kind: "video",
      aspectRatios: ["16:9", "9:16"],
      resolutions: ["720p", "1080p"],
      minDurationSeconds: 8,
      maxDurationSeconds: 20,
      stepSeconds: 4,
      supportsAudio: true,
      supportsFirstFrame: true,
      supportsLastFrame: false,
    },
  },
  /* ── Google ── */
  {
    id: "gemini-3.1-flash-image",
    adapter: "google",
    kind: "image",
    label: "gemini-3.1-flash-image（Google·$0.067-0.15/张，需海外网络）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k", "2k", "4k"],
      maxRefImages: 10,
      // adapter 每次请求只取 candidates[0]，单次仅返回 1 张
      maxBatch: 1,
    },
  },
  {
    id: "gemini-3-pro-image",
    adapter: "google",
    kind: "image",
    label: "gemini-3-pro-image（Google·$0.13-0.24/张）",
    caps: {
      kind: "image",
      aspectRatios: STANDARD_IMAGE_RATIOS,
      resolutionTiers: ["1k", "2k", "4k"],
      maxRefImages: 11,
      maxBatch: 1,
    },
  },
  {
    id: "veo-3.1-fast-generate-preview",
    adapter: "google",
    kind: "video",
    label: "veo-3.1-fast（Google·$0.10-0.30/秒，4/6/8秒）",
    caps: {
      kind: "video",
      aspectRatios: ["16:9", "9:16"],
      resolutions: ["720p", "1080p"],
      minDurationSeconds: 4,
      maxDurationSeconds: 8,
      stepSeconds: 2,
      supportsAudio: true,
      supportsFirstFrame: true,
      supportsLastFrame: true,
    },
  },
  {
    id: "veo-3.1-generate-preview",
    adapter: "google",
    kind: "video",
    label: "veo-3.1（Google·$0.40-0.60/秒，4/6/8秒）",
    caps: {
      kind: "video",
      aspectRatios: ["16:9", "9:16"],
      resolutions: ["720p", "1080p"],
      minDurationSeconds: 4,
      maxDurationSeconds: 8,
      stepSeconds: 2,
      supportsAudio: true,
      supportsFirstFrame: true,
      supportsLastFrame: true,
    },
  },
];

export function findModelEntry(model: string): CatalogModelEntry | null {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return MODEL_CATALOG.find((entry) => entry.id.toLowerCase() === normalized) ?? null;
}

/** 目录外模型的能力兜底：按 adapter 取宽松默认。 */
export function adapterDefaultCaps(adapter: MediaAdapterId, kind: "image" | "video"): ModelCaps {
  if (kind === "image") {
    const maxRefImages = adapter === "zhipu" ? 0 : adapter === "volcengine" ? 10 : adapter === "dashscope" ? 9 : adapter === "modelscope" ? 3 : adapter === "openai" ? 16 : 10;
    return { kind: "image", aspectRatios: ALL_ASPECT_RATIOS, resolutionTiers: ALL_IMAGE_TIERS, maxRefImages, maxBatch: adapter === "google" ? 1 : 4 };
  }
  return {
    kind: "video",
    aspectRatios: adapter === "openai" || adapter === "google" ? ["16:9", "9:16"] : ALL_ASPECT_RATIOS,
    resolutions: ALL_VIDEO_RESOLUTIONS,
    minDurationSeconds: adapter === "openai" ? 8 : 4,
    maxDurationSeconds: adapter === "openai" ? 20 : adapter === "google" ? 8 : 15,
    stepSeconds: adapter === "openai" ? 4 : adapter === "google" ? 2 : 1,
    supportsAudio: true,
    supportsFirstFrame: true,
    supportsLastFrame: true,
  };
}
