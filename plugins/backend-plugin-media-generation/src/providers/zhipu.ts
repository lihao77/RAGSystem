import { httpJson } from "../http.js";
import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import { imagePixels, videoPixels } from "./size.js";
import type { MediaGenAdapter, MediaOutputSource, VideoJobStatus } from "./types.js";
import { normalizeEndpoint, providerApiKey, providerTimeoutMs, toDataUrl } from "./types.js";

/** 智谱（GLM-Image 生图 / CogVideoX-3 生视频）。 */
export function createZhipuAdapter(): MediaGenAdapter {
  return {
    id: "zhipu",

    async generateImage(req, model, ctx) {
      const base = zhipuBase(ctx.provider);
      const headers = { authorization: `Bearer ${providerApiKey(ctx.provider)}` };
      const timeoutMs = providerTimeoutMs(ctx.provider, 300);
      const { width, height } = imagePixels(req.aspectRatio, req.resolutionTier);
      // glm-image 纯文生图（无参考图能力，工具层按 caps 拦截）。
      const requests = Array.from({ length: req.n }, (_, index) =>
        httpJson<{ data?: Array<{ url?: string; b64_json?: string }> }>(`${base}/images/generations`, {
          method: "POST",
          headers,
          body: { model, prompt: index === 0 ? req.prompt : `${req.prompt} (variation ${index + 1})`, size: `${width}x${height}` },
          timeoutMs,
          signal: ctx.signal,
          fetchImpl: ctx.fetchImpl,
        }));
      const responses = await Promise.allSettled(requests);
      const outputs: MediaOutputSource[] = [];
      let firstError: unknown = null;
      // 部分成功优于全败：单张失败不丢弃已计费的其余结果
      for (const response of responses) {
        if (response.status === "rejected") {
          firstError ??= response.reason;
          continue;
        }
        for (const item of response.value.data?.data ?? []) {
          if (item.url) outputs.push({ type: "url", url: item.url, mime: "image/png" });
          else if (item.b64_json) outputs.push({ type: "base64", data: item.b64_json, mime: "image/png" });
        }
      }
      if (outputs.length === 0) {
        throw firstError instanceof Error ? firstError : new Error("智谱生图响应中没有图片数据");
      }
      return outputs;
    },

    async submitVideoJob(req, model, ctx) {
      const base = zhipuBase(ctx.provider);
      const { width, height } = videoPixels(req.aspectRatio, req.resolution);
      // 图生视频：单图 image_url 字符串；首尾帧：image_url 数组 [first, last]。
      let imageUrls: { image_url: string | string[] } | undefined;
      if (req.firstFrame && req.lastFrame) {
        imageUrls = { image_url: [toDataUrl(req.firstFrame), toDataUrl(req.lastFrame)] };
      } else if (req.firstFrame) {
        imageUrls = { image_url: toDataUrl(req.firstFrame) };
      }
      const { data } = await httpJson<{ id?: string; task_status?: string; message?: string }>(`${base}/videos/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${providerApiKey(ctx.provider)}` },
        body: {
          model,
          prompt: req.prompt,
          ...(imageUrls ?? {}),
          size: `${width}x${height}`,
          duration: req.durationSeconds,
          quality: "speed",
          with_audio: req.withAudio,
          watermark_enabled: false,
        },
        timeoutMs: providerTimeoutMs(ctx.provider, 300),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      if (!data.id) throw new Error(`智谱视频任务提交失败: ${data.message ?? "响应缺少任务 id"}`);
      return { jobId: data.id };
    },

    async pollVideoJob(jobId, _model, ctx) {
      const base = zhipuBase(ctx.provider);
      const { data } = await httpJson<{
        task_status?: string;
        message?: string;
        video_result?: Array<{ url?: string; cover_image_url?: string }>;
      }>(`${base}/async-result/${jobId}`, {
        headers: { authorization: `Bearer ${providerApiKey(ctx.provider)}` },
        timeoutMs: providerTimeoutMs(ctx.provider),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      const status = String(data.task_status ?? "").toUpperCase();
      if (status === "SUCCESS") {
        const video = data.video_result?.find((item) => item.url);
        if (!video?.url) return { status: "failed", error: "任务成功但响应缺少视频 URL" };
        return {
          status: "succeeded",
          outputs: {
            video: { type: "url", url: video.url },
            ...(video.cover_image_url ? { cover: { type: "url", url: video.cover_image_url } } : {}),
          },
        };
      }
      if (status === "FAIL") {
        return { status: "failed", error: data.message ?? "智谱视频生成失败" };
      }
      return { status: "running", progressHint: status || "PROCESSING" };
    },
  };
}

function zhipuBase(provider: ModelProviderConfig): string {
  return normalizeEndpoint(provider, "https://open.bigmodel.cn/api/paas/v4", "/api/paas/v4");
}
