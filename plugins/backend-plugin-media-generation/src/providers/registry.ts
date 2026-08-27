import { adapterDefaultCaps, findModelEntry, type ModelCaps } from "../model-catalog.js";
import type { MediaAdapterId } from "../provider-types.js";
import { createDashscopeAdapter } from "./dashscope.js";
import { createGoogleAdapter } from "./google.js";
import { createModelscopeAdapter } from "./modelscope.js";
import { createOpenAiAdapter } from "./openai.js";
import type { MediaGenAdapter } from "./types.js";
import { createVolcengineAdapter } from "./volcengine.js";
import { createZhipuAdapter } from "./zhipu.js";

/** adapter 实例注册表（无状态，按需扩展：新增厂商 = 新 adapter 文件 + 此表一行 + 目录条目）。 */
const ADAPTERS: Readonly<Record<MediaAdapterId, () => MediaGenAdapter>> = {
  volcengine: createVolcengineAdapter,
  zhipu: createZhipuAdapter,
  dashscope: createDashscopeAdapter,
  modelscope: createModelscopeAdapter,
  openai: createOpenAiAdapter,
  google: createGoogleAdapter,
};

export function getMediaAdapter(adapterId: MediaAdapterId): MediaGenAdapter {
  return ADAPTERS[adapterId]();
}

/** 模型能力解析：目录命中用目录 caps（含 custom 校验），否则按 adapter 宽松默认。 */
export function resolveModelCaps(adapterId: MediaAdapterId, model: string, kind: "image" | "video"): ModelCaps {
  const entry = findModelEntry(model);
  if (entry && entry.adapter === adapterId && entry.caps.kind === kind) return entry.caps;
  return adapterDefaultCaps(adapterId, kind);
}

/* ── 入参规整：越界夹到最近合法档，并说明调整 ── */

export interface NormalizedImageParams {
  aspectRatio: string;
  resolutionTier: string;
  n: number;
  notes: string[];
}

const TIER_ORDER = ["1k", "2k", "4k"] as const;

/** 档位就近夹取：请求档不受支持时向下取最近的受支持档。 */
function clampResolutionTier(requested: string | undefined, supported: readonly string[]): string {
  if (requested && supported.includes(requested)) return requested;
  const index = requested ? TIER_ORDER.indexOf(requested as never) : -1;
  if (index > 0) {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (supported.includes(TIER_ORDER[i]!)) return TIER_ORDER[i]!;
    }
  }
  return supported[0]!;
}

export function normalizeImageParams(
  caps: Extract<ModelCaps, { kind: "image" }>,
  input: { aspectRatio?: string | undefined; resolutionTier?: string | undefined; n?: number | undefined },
): NormalizedImageParams {
  const notes: string[] = [];
  const aspectRatio = caps.aspectRatios.includes(input.aspectRatio as never)
    ? (input.aspectRatio ?? caps.aspectRatios[0])!
    : caps.aspectRatios[0]!;
  if (input.aspectRatio && input.aspectRatio !== aspectRatio) {
    notes.push(`比例 ${input.aspectRatio} 不受支持，已调整为 ${aspectRatio}`);
  }
  const resolutionTier = clampResolutionTier(input.resolutionTier, caps.resolutionTiers);
  if (input.resolutionTier && input.resolutionTier !== resolutionTier) {
    notes.push(`分辨率档 ${input.resolutionTier} 不受支持，已调整为 ${resolutionTier}`);
  }
  const requested = Math.min(Math.max(Math.trunc(input.n ?? 1), 1), caps.maxBatch);
  if ((input.n ?? 1) !== requested) {
    notes.push(`张数已调整为 ${requested}（上限 ${caps.maxBatch}）`);
  }
  return { aspectRatio, resolutionTier, n: requested, notes };
}

export interface NormalizedVideoParams {
  aspectRatio: string;
  resolution: string;
  durationSeconds: number;
  withAudio: boolean;
  notes: string[];
}

export function normalizeVideoParams(
  caps: Extract<ModelCaps, { kind: "video" }>,
  input: { aspectRatio?: string | undefined; resolution?: string | undefined; durationSeconds?: number | undefined; withAudio?: boolean | undefined },
): NormalizedVideoParams {
  const notes: string[] = [];
  const aspectRatio = caps.aspectRatios.includes(input.aspectRatio as never)
    ? (input.aspectRatio ?? caps.aspectRatios[0])!
    : caps.aspectRatios[0]!;
  if (input.aspectRatio && input.aspectRatio !== aspectRatio) {
    notes.push(`比例 ${input.aspectRatio} 不受支持，已调整为 ${aspectRatio}`);
  }
  const resolution = caps.resolutions.includes(input.resolution as never)
    ? (input.resolution ?? caps.resolutions[0])!
    : caps.resolutions[0]!;
  if (input.resolution && input.resolution !== resolution) {
    notes.push(`分辨率 ${input.resolution} 不受支持，已调整为 ${resolution}`);
  }
  // 时长夹到 [min, max] 并按步进取整。
  const stepped = Math.round((input.durationSeconds ?? caps.minDurationSeconds) / caps.stepSeconds) * caps.stepSeconds;
  const durationSeconds = Math.min(Math.max(stepped, caps.minDurationSeconds), caps.maxDurationSeconds);
  if ((input.durationSeconds ?? caps.minDurationSeconds) !== durationSeconds) {
    notes.push(`时长已调整为 ${durationSeconds} 秒（支持 ${caps.minDurationSeconds}-${caps.maxDurationSeconds} 秒，步进 ${caps.stepSeconds}）`);
  }
  const withAudio = caps.supportsAudio ? (input.withAudio ?? true) : false;
  if (!caps.supportsAudio && input.withAudio === true) {
    notes.push("该模型不支持音频，已忽略 with_audio");
  }
  return { aspectRatio, resolution, durationSeconds, withAudio, notes };
}
