import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";

import type { MediaAdapterId } from "../provider-types.js";
import type { AspectRatio, ImageResolutionTier, VideoResolution } from "../model-catalog.js";
import type { FetchLike } from "../http.js";

/* ── 统一内部形态（与厂商解耦；adapter 吸收全部差异） ── */

export interface MediaImageInput {
  bytes: Uint8Array;
  mime: string;
}

export interface ImageGenRequest {
  prompt: string;
  aspectRatio: AspectRatio;
  resolutionTier: ImageResolutionTier;
  /** 生成张数（1-4）。 */
  n: number;
  /** 参考图（图生图/编辑）；能力上限由 caps.maxRefImages 声明。 */
  refImages: readonly MediaImageInput[];
  watermark: boolean;
}

export type MediaOutputSource =
  | { type: "base64"; data: string; mime: string }
  | { type: "url"; url: string; mime: string };

export interface VideoGenRequest {
  prompt: string;
  durationSeconds: number;
  resolution: VideoResolution;
  aspectRatio: AspectRatio;
  withAudio: boolean;
  firstFrame?: MediaImageInput | undefined;
  lastFrame?: MediaImageInput | undefined;
}

export type VideoJobPhase = "running" | "succeeded" | "failed";

export interface VideoJobOutputs {
  video: { type: "url"; url: string } | { type: "bytes"; data: Buffer; mime: string };
  cover?: { type: "url"; url: string } | undefined;
}

export interface VideoJobStatus {
  status: VideoJobPhase;
  /** 展示用状态说明（如厂商原始状态）。 */
  progressHint?: string | undefined;
  error?: string | undefined;
  outputs?: VideoJobOutputs | undefined;
}

/** adapter 执行上下文：凭证来自 Provider 条目；signal 取消跟随工具执行。 */
export interface AdapterCallContext {
  provider: ModelProviderConfig;
  signal: AbortSignal | null;
  fetchImpl?: FetchLike | undefined;
}

export interface MediaGenAdapter {
  readonly id: MediaAdapterId;
  /** 同步生图（内部可为多次请求）。 */
  generateImage(req: ImageGenRequest, model: string, ctx: AdapterCallContext): Promise<MediaOutputSource[]>;
  /** 提交异步视频任务。 */
  submitVideoJob(req: VideoGenRequest, model: string, ctx: AdapterCallContext): Promise<{ jobId: string }>;
  /** 查询异步视频任务（succeeded 时给 outputs；需鉴权下载的厂商在此完成下载）。 */
  pollVideoJob(jobId: string, model: string, ctx: AdapterCallContext): Promise<VideoJobStatus>;
}

/* ── adapter 共享工具 ── */

export function toDataUrl(image: MediaImageInput): string {
  return `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

export function providerTimeoutMs(provider: ModelProviderConfig, fallbackSeconds = 120): number {
  const value = Number(provider.timeout);
  return Number.isFinite(value) && value >= 5 ? value * 1000 : fallbackSeconds * 1000;
}

export function providerApiKey(provider: ModelProviderConfig): string {
  const key = String(provider.api_key ?? "").trim();
  if (!key) {
    throw new Error(`媒体 Provider「${provider.name ?? provider.key ?? ""}」未配置 API Key，请在模型 Provider 管理页填写。`);
  }
  return key;
}

/** 归一 endpoint：去尾部斜杠；可选确保包含 suffix（厂商 API 根路径）。 */
export function normalizeEndpoint(provider: ModelProviderConfig, defaultBase: string, requiredSuffix?: string): string {
  let base = String(provider.api_endpoint ?? "").trim() || defaultBase;
  base = base.replace(/\/+$/, "");
  if (requiredSuffix && !base.endsWith(requiredSuffix)) {
    base = `${base}${requiredSuffix}`;
  }
  return base;
}
