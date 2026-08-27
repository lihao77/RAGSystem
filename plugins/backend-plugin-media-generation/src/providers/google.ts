import { downloadBinary, httpJson } from "../http.js";
import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type { MediaGenAdapter, VideoJobStatus } from "./types.js";
import { normalizeEndpoint, providerApiKey, providerTimeoutMs } from "./types.js";

/** Google（nano banana 生图 / Veo 3.1 生视频）。视频仅保留 2 天：poll 完成即带鉴权下载。 */
export function createGoogleAdapter(): MediaGenAdapter {
  return {
    id: "google",

    async generateImage(req, model, ctx) {
      const base = googleBase(ctx.provider);
      const apiKey = providerApiKey(ctx.provider);
      const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
      for (const image of req.refImages) {
        parts.push({
          inline_data: {
            mime_type: image.mime,
            data: Buffer.from(image.bytes).toString("base64"),
          },
        });
      }
      const { data } = await httpJson<{
        candidates?: Array<{
          content?: { parts?: Array<{ inline_data?: { mime_type?: string; data?: string } }> };
        }>;
        error?: { message?: string };
        promptFeedback?: { blockReason?: string };
      }>(`${base}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey },
        body: {
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: req.aspectRatio, imageSize: req.resolutionTier.toUpperCase() },
          },
        },
        timeoutMs: providerTimeoutMs(ctx.provider, 300),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      if (data.promptFeedback?.blockReason) {
        throw new Error(`Google 生图被安全策略拦截: ${data.promptFeedback.blockReason}`);
      }
      const outputs = (data.candidates?.[0]?.content?.parts ?? []).flatMap((part) => {
        const inline = part.inline_data;
        return inline?.data ? [{ type: "base64" as const, data: inline.data, mime: String(inline.mime_type ?? "image/png") }] : [];
      });
      if (outputs.length === 0) {
        throw new Error(`Google 生图响应中没有图片数据: ${data.error?.message ?? "无 inline_data"}`);
      }
      return outputs;
    },

    async submitVideoJob(req, model, ctx) {
      const base = googleBase(ctx.provider);
      const instance: Record<string, unknown> = { prompt: req.prompt };
      if (req.firstFrame) {
        instance.image = {
          bytesBase64Encoded: Buffer.from(req.firstFrame.bytes).toString("base64"),
          mimeType: req.firstFrame.mime,
        };
      }
      if (req.lastFrame) {
        instance.lastFrame = {
          bytesBase64Encoded: Buffer.from(req.lastFrame.bytes).toString("base64"),
          mimeType: req.lastFrame.mime,
        };
      }
      const { data } = await httpJson<{ name?: string; error?: { message?: string } }>(
        `${base}/models/${model}:predictLongRunning`,
        {
          method: "POST",
          headers: { "x-goog-api-key": providerApiKey(ctx.provider) },
          body: {
            instances: [instance],
            parameters: {
              aspectRatio: req.aspectRatio === "9:16" ? "9:16" : "16:9",
              resolution: req.resolution,
              durationSeconds: req.durationSeconds,
              generateAudio: req.withAudio,
            },
          },
          timeoutMs: providerTimeoutMs(ctx.provider, 300),
          signal: ctx.signal,
          fetchImpl: ctx.fetchImpl,
        },
      );
      if (!data.name) throw new Error(`Veo 任务提交失败: ${data.error?.message ?? "响应缺少 operation name"}`);
      return { jobId: data.name };
    },

    async pollVideoJob(jobId, _model, ctx) {
      const base = googleBase(ctx.provider);
      const headers = { "x-goog-api-key": providerApiKey(ctx.provider) };
      const { data } = await httpJson<{
        done?: boolean;
        error?: { message?: string };
        response?: {
          generateVideoResponse?: {
            generatedSamples?: Array<{ video?: { uri?: string } }>;
            raiMediaFilteredReasons?: string[];
          };
        };
      }>(`${base}/${jobId.replace(/^\/+/, "")}`, {
        headers,
        timeoutMs: providerTimeoutMs(ctx.provider),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      if (!data.done) return { status: "running", progressHint: "processing" };
      if (data.error) return { status: "failed", error: data.error.message ?? "Veo 生成失败" };
      const uri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) {
        const filtered = data.response?.generateVideoResponse?.raiMediaFilteredReasons?.join("; ");
        return { status: "failed", error: filtered ? `Veo 被安全策略过滤: ${filtered}` : "任务完成但响应缺少视频 URI" };
      }
      // 视频在服务器仅保留 2 天且 URI 需鉴权：poll 完成即下载为 bytes。
      const video = await downloadBinary(uri, {
        headers,
        timeoutMs: providerTimeoutMs(ctx.provider, 600),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      return {
        status: "succeeded",
        outputs: { video: { type: "bytes", data: video.bytes, mime: video.contentType } },
      };
    },
  };
}

function googleBase(provider: ModelProviderConfig): string {
  return normalizeEndpoint(provider, "https://generativelanguage.googleapis.com/v1beta", "/v1beta");
}
