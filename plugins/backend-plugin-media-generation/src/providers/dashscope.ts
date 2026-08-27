import { httpJson } from "../http.js";
import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import { imagePixels } from "./size.js";
import type { MediaGenAdapter, MediaOutputSource, VideoJobStatus } from "./types.js";
import { normalizeEndpoint, providerApiKey, providerTimeoutMs, toDataUrl } from "./types.js";

/** 阿里云百炼/通义万相（wan2.x 生图生视频，DashScope 风格）。 */
export function createDashscopeAdapter(): MediaGenAdapter {
  return {
    id: "dashscope",

    async generateImage(req, model, ctx) {
      const base = dashscopeBase(ctx.provider);
      // 万相走类对话 messages 结构：content 数组 = text + 参考图（0-9 张）。
      const content: Array<Record<string, string>> = [{ text: req.prompt }];
      for (const image of req.refImages) {
        content.push({ image: toDataUrl(image) });
      }
      const { width, height } = imagePixels(req.aspectRatio, req.resolutionTier);
      const { data } = await httpJson<{
        output?: {
          choices?: Array<{ message?: { content?: Array<{ image?: string }> } }>;
          message?: string;
          code?: string;
        };
        code?: string;
        message?: string;
      }>(`${base}/api/v1/services/aigc/multimodal-generation/generation`, {
        method: "POST",
        headers: { authorization: `Bearer ${providerApiKey(ctx.provider)}` },
        body: {
          model,
          input: { messages: [{ role: "user", content }] },
          parameters: { size: `${width}x${height}`, n: req.n, watermark: false, prompt_extend: true },
        },
        timeoutMs: providerTimeoutMs(ctx.provider, 300),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      if (data.code || data.output?.code) {
        throw new Error(`百炼生图失败: ${data.message ?? data.output?.message ?? data.code ?? "未知错误"}`);
      }
      const outputs: MediaOutputSource[] = [];
      for (const choice of data.output?.choices ?? []) {
        for (const part of choice.message?.content ?? []) {
          if (part.image) outputs.push({ type: "url", url: part.image, mime: "image/png" });
        }
      }
      if (outputs.length === 0) throw new Error("百炼生图响应中没有图片数据");
      return outputs;
    },

    async submitVideoJob(req, model, ctx) {
      const base = dashscopeBase(ctx.provider);
      const { data } = await httpJson<{ output?: { task_id?: string; task_status?: string; message?: string }; code?: string; message?: string }>(
        `${base}/api/v1/services/aigc/video-generation/video-synthesis`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${providerApiKey(ctx.provider)}`, "x-dashscope-async": "enable" },
          body: {
            model,
            input: {
              prompt: req.prompt,
              ...(req.firstFrame ? { first_frame_url: toDataUrl(req.firstFrame) } : {}),
              ...(req.lastFrame ? { last_frame_url: toDataUrl(req.lastFrame) } : {}),
            },
            parameters: {
              resolution: req.resolution.toUpperCase(),
              ratio: req.aspectRatio,
              duration: req.durationSeconds,
              prompt_extend: true,
            },
          },
          timeoutMs: providerTimeoutMs(ctx.provider, 300),
          signal: ctx.signal,
          fetchImpl: ctx.fetchImpl,
        },
      );
      if (data.code || !data.output?.task_id) {
        throw new Error(`百炼视频任务提交失败: ${data.message ?? data.output?.message ?? "响应缺少 task_id"}`);
      }
      return { jobId: data.output.task_id };
    },

    async pollVideoJob(jobId, _model, ctx) {
      const base = dashscopeBase(ctx.provider);
      const { data } = await httpJson<{
        output?: { task_status?: string; video_url?: string; message?: string; code?: string };
      }>(`${base}/api/v1/tasks/${jobId}`, {
        headers: { authorization: `Bearer ${providerApiKey(ctx.provider)}` },
        timeoutMs: providerTimeoutMs(ctx.provider),
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      });
      const status = String(data.output?.task_status ?? "").toUpperCase();
      if (status === "SUCCEEDED") {
        const videoUrl = data.output?.video_url;
        if (!videoUrl) return { status: "failed", error: "任务成功但响应缺少 video_url" };
        return { status: "succeeded", outputs: { video: { type: "url", url: videoUrl } } };
      }
      if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
        return { status: "failed", error: data.output?.message ?? `百炼视频任务状态: ${status}` };
      }
      return { status: "running", progressHint: status || "RUNNING" };
    },
  };
}

function dashscopeBase(provider: ModelProviderConfig): string {
  return normalizeEndpoint(provider, "https://dashscope.aliyuncs.com");
}
