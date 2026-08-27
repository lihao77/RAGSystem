import { httpJson } from "../http.js";
import type { AdapterCallContext, MediaGenAdapter, MediaOutputSource, VideoJobStatus } from "./types.js";
import { normalizeEndpoint, providerApiKey, providerTimeoutMs, toDataUrl } from "./types.js";

/** 火山方舟（豆包 Seedream 生图 / Seedance 生视频）。 */
export function createVolcengineAdapter(): MediaGenAdapter {
  return {
    id: "volcengine",

    async generateImage(req, model, ctx) {
      const apiBase = arkBase(ctx);
      const headers = { authorization: `Bearer ${providerApiKey(ctx.provider)}` };
      const timeoutMs = providerTimeoutMs(ctx.provider, 300);
      // 火山接受档位字符串（1K/2K/4K 自适应比例）+ 参考图（Seedream 5 系 image 数组）。
      const size = req.resolutionTier.toUpperCase();
      const body = (prompt: string): Record<string, unknown> => ({
        model,
        prompt,
        size,
        ...(req.refImages.length ? { image: req.refImages.map((image) => toDataUrl(image)) } : {}),
        response_format: "b64_json",
        watermark: req.watermark,
      });
      const requests = Array.from({ length: req.n }, (_, index) =>
        httpJson<{ data?: Array<{ b64_json?: string; url?: string }> }>(`${apiBase}/images/generations`, {
          method: "POST",
          headers,
          body: body(index === 0 ? req.prompt : `${req.prompt} (variation ${index + 1})`),
          timeoutMs,
          signal: ctx.signal,
          fetchImpl: ctx.fetchImpl,
        }));
      // 部分成功优于全败：单张失败不丢弃已计费的其余结果
      const settled = await Promise.allSettled(requests);
      const outputs: MediaOutputSource[] = [];
      let firstError: unknown = null;
      for (const result of settled) {
        if (result.status === "rejected") {
          firstError ??= result.reason;
          continue;
        }
        for (const item of result.value.data?.data ?? []) {
          if (item.b64_json) outputs.push({ type: "base64", data: item.b64_json, mime: "image/png" });
          else if (item.url) outputs.push({ type: "url", url: item.url, mime: "image/png" });
        }
      }
      if (outputs.length === 0) {
        throw firstError instanceof Error ? firstError : new Error("火山方舟生图响应中没有图片数据");
      }
      return outputs;
    },

    async submitVideoJob(req, model, ctx) {
      const apiBase = arkBase(ctx);
      const content: Array<Record<string, unknown>> = [{ type: "text", text: req.prompt }];
      if (req.firstFrame) {
        content.push({ type: "image_url", image_url: { url: toDataUrl(req.firstFrame) }, role: "first_frame" });
      }
      if (req.lastFrame) {
        content.push({ type: "image_url", image_url: { url: toDataUrl(req.lastFrame) }, role: "last_frame" });
      }
      const { data } = await httpJson<{ id?: string }>(`${apiBase}/contents/generations/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${providerApiKey(ctx.provider)}` },
        body: {
          model,
          content,
          ratio: req.aspectRatio,
          resolution: req.resolution,
          duration: req.durationSeconds,
          ...(req.withAudio ? { generate_audio: true } : {}),
          watermark: false,
          return_url: true,
        },
        timeoutMs: providerTimeoutMs(ctx.provider, 300),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      if (!data.id) throw new Error("火山方舟视频任务提交失败：响应缺少任务 id");
      return { jobId: data.id };
    },

    async pollVideoJob(jobId, _model, ctx) {
      const apiBase = arkBase(ctx);
      const { data } = await httpJson<{
        status?: string;
        content?: { video_url?: string };
        error?: { message?: string } | string;
        usage?: unknown;
      }>(`${apiBase}/contents/generations/tasks/${jobId}`, {
        headers: { authorization: `Bearer ${providerApiKey(ctx.provider)}` },
        timeoutMs: providerTimeoutMs(ctx.provider),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      const status = String(data.status ?? "").toLowerCase();
      if (status === "succeeded") {
        const videoUrl = data.content?.video_url;
        if (!videoUrl) return { status: "failed", error: "任务成功但响应缺少 video_url" };
        return { status: "succeeded", outputs: { video: { type: "url", url: videoUrl } } };
      }
      if (status === "failed" || status === "cancelled") {
        const message = typeof data.error === "string" ? data.error : data.error?.message ?? "厂商侧生成失败";
        return { status: "failed", error: message };
      }
      return { status: "running", progressHint: status || "processing" };
    },
  };
}

function arkBase(ctx: AdapterCallContext): string {
  const base = normalizeEndpoint(ctx.provider, "https://ark.cn-beijing.volces.com");
  return base.endsWith("/api/v3") ? base : `${base}/api/v3`;
}
