import { downloadBinary, httpJson } from "../http.js";
import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import { openAiImageSize, openAiVideoSize } from "./size.js";
import type { MediaGenAdapter, MediaOutputSource, VideoJobStatus } from "./types.js";
import { normalizeEndpoint, providerApiKey, providerTimeoutMs, toDataUrl } from "./types.js";

/** OpenAI（gpt-image 生图 / Sora 2 生视频）。gpt-image 系恒返 b64；Sora 下载链接 1h 有效——poll 内完成下载。 */
export function createOpenAiAdapter(): MediaGenAdapter {
  return {
    id: "openai",

    async generateImage(req, model, ctx) {
      const base = openAiBase(ctx.provider);
      const headers = { authorization: `Bearer ${providerApiKey(ctx.provider)}` };
      const timeoutMs = providerTimeoutMs(ctx.provider, 300);
      const size = openAiImageSize(req.aspectRatio);
      // 有参考图走 edits（images 数组为裸 base64，非 data URL）；否则 generations。
      const { data } = req.refImages.length
        ? await httpJson<{ data?: Array<{ b64_json?: string; url?: string }> }>(`${base}/images/edits`, {
          method: "POST",
          headers,
          body: {
            model,
            prompt: req.prompt,
            images: req.refImages.map((image) => Buffer.from(image.bytes).toString("base64")),
            size,
            n: req.n,
          },
          timeoutMs,
          signal: ctx.signal,
          fetchImpl: ctx.fetchImpl,
        })
        : await httpJson<{ data?: Array<{ b64_json?: string; url?: string }> }>(`${base}/images/generations`, {
          method: "POST",
          headers,
          body: { model, prompt: req.prompt, size, n: req.n },
          timeoutMs,
          signal: ctx.signal,
          fetchImpl: ctx.fetchImpl,
        });
      const outputs: MediaOutputSource[] = [];
      for (const item of data.data ?? []) {
        if (item.b64_json) outputs.push({ type: "base64", data: item.b64_json, mime: "image/png" });
        else if (item.url) outputs.push({ type: "url", url: item.url, mime: "image/png" });
      }
      if (outputs.length === 0) throw new Error("OpenAI 生图响应中没有图片数据");
      return outputs;
    },

    async submitVideoJob(req, model, ctx) {
      const base = openAiBase(ctx.provider);
      const { data } = await httpJson<{ id?: string; status?: string; error?: { message?: string } }>(`${base}/videos`, {
        method: "POST",
        headers: { authorization: `Bearer ${providerApiKey(ctx.provider)}` },
        body: {
          model,
          prompt: req.prompt,
          seconds: req.durationSeconds,
          size: openAiVideoSize(req.aspectRatio, req.resolution),
          ...(req.firstFrame ? { input_reference: { image_url: toDataUrl(req.firstFrame) } } : {}),
        },
        timeoutMs: providerTimeoutMs(ctx.provider, 300),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      if (!data.id) throw new Error(`Sora 任务提交失败: ${data.error?.message ?? "响应缺少任务 id"}`);
      return { jobId: data.id };
    },

    async pollVideoJob(jobId, _model, ctx) {
      const base = openAiBase(ctx.provider);
      const headers = { authorization: `Bearer ${providerApiKey(ctx.provider)}` };
      const { data } = await httpJson<{
        status?: string;
        progress?: number;
        error?: { message?: string } | string;
      }>(`${base}/videos/${jobId}`, {
        headers,
        timeoutMs: providerTimeoutMs(ctx.provider),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      const status = String(data.status ?? "").toLowerCase();
      if (status === "completed") {
        // 下载链接 1h 有效：poll 完成即取（带鉴权），返回 bytes。
        const video = await downloadBinary(`${base}/videos/${jobId}/content`, {
          headers,
          timeoutMs: providerTimeoutMs(ctx.provider, 600),
          signal: ctx.signal,
          fetchImpl: ctx.fetchImpl,
        });
        return {
          status: "succeeded",
          outputs: { video: { type: "bytes", data: video.bytes, mime: video.contentType } },
        };
      }
      if (status === "failed") {
        const message = typeof data.error === "string" ? data.error : data.error?.message ?? "Sora 生成失败";
        return { status: "failed", error: message };
      }
      const hint = typeof data.progress === "number" ? `${status} ${Math.round(data.progress)}%` : status;
      return { status: "running", progressHint: hint || "in_progress" };
    },
  };
}

function openAiBase(provider: ModelProviderConfig): string {
  return normalizeEndpoint(provider, "https://api.openai.com/v1", "/v1");
}
