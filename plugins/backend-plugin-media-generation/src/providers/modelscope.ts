import { httpJson } from "../http.js";
import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import { imagePixels } from "./size.js";
import type { AdapterCallContext, MediaGenAdapter, MediaOutputSource } from "./types.js";
import { normalizeEndpoint, providerApiKey, providerTimeoutMs, toDataUrl } from "./types.js";

/** 生图任务整体等待上限（单次 HTTP 请求超时由 Provider timeout 控制）。 */
const TASK_MAX_WAIT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 3_000;

/**
 * 魔搭社区 ModelScope API-Inference：AIGC 生图走异步任务（提交 + 轮询，
 * 输出公网图片 URL）。官方未开放视频生成 API，video 方法明确报不支持。
 */
export function createModelscopeAdapter(): MediaGenAdapter {
  return {
    id: "modelscope",

    async generateImage(req, model, ctx) {
      const base = modelscopeBase(ctx.provider);
      const apiKey = providerApiKey(ctx.provider);
      const timeoutMs = providerTimeoutMs(ctx.provider, 300);
      const { width, height } = clampToModelMax(model, imagePixels(req.aspectRatio, req.resolutionTier));
      const body = {
        model,
        prompt: req.prompt,
        size: `${width}x${height}`,
        // 图像编辑模型经 image_url 接收参考图（base64 data URL 数组），纯文生图模型忽略该字段。
        ...(req.refImages.length > 0 ? { image_url: req.refImages.map((image) => toDataUrl(image)) } : {}),
      };
      // 无原生批量参数：n>1 并发提交 n 个任务（部分成功优于全败）。
      const requests = Array.from({ length: req.n }, (_, index) =>
        runImageTask(base, apiKey, index === 0 ? body : { ...body, prompt: `${req.prompt} (variation ${index + 1})` }, ctx, timeoutMs));
      const responses = await Promise.allSettled(requests);
      const outputs: MediaOutputSource[] = [];
      let firstError: unknown = null;
      for (const response of responses) {
        if (response.status === "rejected") {
          firstError ??= response.reason;
          continue;
        }
        outputs.push(...response.value);
      }
      if (outputs.length === 0) {
        throw firstError instanceof Error ? firstError : new Error("魔搭生图响应中没有图片数据");
      }
      return outputs;
    },

    async submitVideoJob() {
      throw new Error("魔搭社区 API-Inference 暂未开放视频生成 API（当前仅生图）；请改用百炼/火山/智谱等厂商的生视频模型。");
    },

    async pollVideoJob() {
      throw new Error("魔搭社区 API-Inference 暂未开放视频生成 API。");
    },
  };
}

/** 提交生图任务并轮询到完成，返回图片 URL 列表。 */
async function runImageTask(
  base: string,
  apiKey: string,
  body: Record<string, unknown>,
  ctx: AdapterCallContext,
  timeoutMs: number,
): Promise<MediaOutputSource[]> {
  const submit = await httpJson<{ task_id?: string }>(`${base}/v1/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "x-modelscope-async-mode": "true" },
    body,
    timeoutMs,
    signal: ctx.signal,
    fetchImpl: ctx.fetchImpl,
  });
  const taskId = submit.data.task_id;
  if (!taskId) throw new Error("魔搭生图任务提交失败: 响应缺少 task_id");

  const deadline = Date.now() + TASK_MAX_WAIT_MS;
  // 首查不等待（快档模型数秒即完），之后每 3s 轮询一次。
  let waitMs = 0;
  for (;;) {
    await abortableDelay(waitMs, ctx.signal);
    waitMs = POLL_INTERVAL_MS;
    const { data } = await httpJson<{ task_status?: string; output_images?: string[]; errors?: unknown; message?: string }>(
      `${base}/v1/tasks/${taskId}`,
      {
        headers: { authorization: `Bearer ${apiKey}`, "x-modelscope-task-type": "image_generation" },
        timeoutMs,
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
      },
    );
    const status = String(data.task_status ?? "").toUpperCase();
    if (status === "SUCCEED" || status === "SUCCEEDED") {
      const urls = (data.output_images ?? []).filter((url) => typeof url === "string" && url.trim());
      if (urls.length === 0) throw new Error(`魔搭生图任务 ${taskId} 成功但响应缺少图片 URL`);
      return urls.map((url) => ({ type: "url" as const, url, mime: "image/png" }));
    }
    if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
      throw new Error(`魔搭生图任务失败: ${taskErrorText(data) ?? status}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`魔搭生图任务 ${taskId} 等待超时（${Math.round(TASK_MAX_WAIT_MS / 60_000)} 分钟），请稍后重试或换用更快模型`);
    }
  }
}

/** 可被 AbortSignal 打断的等待。 */
function abortableDelay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("生图任务已取消"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("生图任务已取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 各模型系单边分辨率上限（魔搭文档：FLUX 1024 / Qwen-Image 1664 / SD 与 Z-Image 2048）。 */
function modelscopeMaxDimension(model: string): number {
  const id = String(model).toLowerCase();
  if (id.includes("flux")) return 1024;
  if (id.includes("qwen-image") || id.includes("qwen_image")) return 1664;
  return 2048;
}

/** 超模型上限时等比缩入上限（保持比例取整）。 */
function clampToModelMax(model: string, size: { width: number; height: number }): { width: number; height: number } {
  const max = modelscopeMaxDimension(model);
  if (size.width <= max && size.height <= max) return size;
  const scale = max / Math.max(size.width, size.height);
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

function taskErrorText(data: { errors?: unknown; message?: string }): string | null {
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  if (typeof data.errors === "string" && data.errors.trim()) return data.errors;
  if (data.errors !== null && typeof data.errors === "object") return JSON.stringify(data.errors).slice(0, 200);
  return null;
}

function modelscopeBase(provider: ModelProviderConfig): string {
  return normalizeEndpoint(provider, "https://api-inference.modelscope.cn");
}
