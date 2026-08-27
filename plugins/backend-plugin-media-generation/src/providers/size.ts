import type { AspectRatio, ImageResolutionTier, VideoResolution } from "../model-catalog.js";

/**
 * 像素档位映射：比例 × 档位 → 宽高（32 的倍数，智谱要求）。
 * 仅用于需要显式像素尺寸的厂商；火山/百炼生图直接传档位字符串。
 */
const IMAGE_PIXELS: Readonly<Record<AspectRatio, Readonly<Record<ImageResolutionTier, [number, number]>>>> = {
  "1:1": { "1k": [1024, 1024], "2k": [2048, 2048], "4k": [2048, 2048] },
  "16:9": { "1k": [1728, 960], "2k": [2048, 1152], "4k": [2048, 1152] },
  "9:16": { "1k": [960, 1728], "2k": [1152, 2048], "4k": [1152, 2048] },
  "4:3": { "1k": [1408, 1056], "2k": [2048, 1536], "4k": [2048, 1536] },
  "3:4": { "1k": [1056, 1408], "2k": [1536, 2048], "4k": [1536, 2048] },
};

const VIDEO_PIXELS: Readonly<Record<VideoResolution, Readonly<Record<AspectRatio, [number, number]>>>> = {
  "720p": {
    "1:1": [960, 960],
    "16:9": [1280, 720],
    "9:16": [720, 1280],
    "4:3": [1280, 960],
    "3:4": [960, 1280],
  },
  "1080p": {
    "1:1": [1440, 1440],
    "16:9": [1920, 1080],
    "9:16": [1080, 1920],
    "4:3": [1920, 1440],
    "3:4": [1440, 1920],
  },
};

export function imagePixels(ratio: AspectRatio, tier: ImageResolutionTier): { width: number; height: number } {
  const [width, height] = IMAGE_PIXELS[ratio]?.[tier] ?? [1024, 1024];
  return { width, height };
}

export function videoPixels(ratio: AspectRatio, resolution: VideoResolution): { width: number; height: number } {
  const [width, height] = VIDEO_PIXELS[resolution]?.[ratio] ?? [1280, 720];
  return { width, height };
}

/** OpenAI gpt-image 固定尺寸档。 */
export function openAiImageSize(ratio: AspectRatio): string {
  switch (ratio) {
    case "16:9":
    case "4:3":
      return "1536x1024";
    case "9:16":
    case "3:4":
      return "1024x1536";
    default:
      return "1024x1024";
  }
}

/** OpenAI Sora 2 视频尺寸。 */
export function openAiVideoSize(ratio: AspectRatio, resolution: VideoResolution): string {
  if (resolution === "1080p") return ratio === "9:16" ? "1080x1920" : "1920x1080";
  return ratio === "9:16" ? "720x1280" : "1280x720";
}
