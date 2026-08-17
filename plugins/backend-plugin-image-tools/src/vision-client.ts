import { createHash } from "node:crypto";

import { LlmProviderClient, type ProviderConfig } from "@ragsystem/agent-llm";
import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";

const DESCRIBE_IMAGE_PROMPT =
  "请客观、简洁地描述这张图片：1) 可见文字（原文照抄）；2) 布局与结构；3) 主要对象、人物或图表内容；" +
  "4) 关键数字或结论；5) 无法确定的内容明确标注不确定。";

/** 共享缓存上限；达到上限时整体清空（简单策略，防止长期运行内存膨胀）。 */
const CACHE_LIMIT = 500;

export interface DescribeImageOptions {
  bytes: Uint8Array;
  mime: string;
  signal?: AbortSignal | null;
}

/** 视觉辅助模型调用面（可替换，便于测试）。 */
export interface VisionHelper {
  describeImage(options: DescribeImageOptions): Promise<string | null>;
}

export interface VisionHelperDeps {
  provider: ModelProviderConfig;
  modelName: string;
  maxCompletionTokens: number;
  timeoutSeconds: number;
  cacheEnabled: boolean;
  client?: LlmProviderClient;
  /** 外部共享缓存（可跨 helper 实例复用；key 含 namespace/provider/model/图片哈希）。 */
  cache?: Map<string, string>;
  /** 缓存命名空间（如租户 id），避免跨实例 key 冲突。 */
  cacheNamespace?: string;
}

/** 调用系统模型中配置的视觉模型生成图片文字描述；失败/超时返回 null（不阻塞消息）。 */
export class OpenAiVisionHelper implements VisionHelper {
  private readonly cache: Map<string, string>;
  private readonly client: LlmProviderClient;
  private readonly provider: ProviderConfig;
  private readonly modelName: string;
  private readonly maxCompletionTokens: number;
  private readonly timeoutSeconds: number;
  private readonly cacheEnabled: boolean;
  private readonly cacheNamespace: string;

  constructor(deps: VisionHelperDeps) {
    this.client = deps.client ?? new LlmProviderClient();
    this.provider = toProviderConfig(deps.provider);
    this.modelName = deps.modelName;
    this.maxCompletionTokens = deps.maxCompletionTokens;
    this.timeoutSeconds = deps.timeoutSeconds;
    this.cacheEnabled = deps.cacheEnabled;
    this.cache = deps.cache ?? new Map<string, string>();
    this.cacheNamespace = deps.cacheNamespace ?? "";
  }

  async describeImage({ bytes, mime, signal }: DescribeImageOptions): Promise<string | null> {
    if (bytes.length === 0) return null;
    const cacheKey = this.cacheKey(bytes);
    if (this.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) return cached;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const dataUrl = `data:${normalizeImageMime(mime)};base64,${Buffer.from(bytes).toString("base64")}`;
        const result = await this.client.complete({
          provider: this.provider,
          model: this.modelName,
          temperature: 0,
          maxCompletionTokens: this.maxCompletionTokens,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: DESCRIBE_IMAGE_PROMPT },
                { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
              ],
            },
          ],
          signal: controller.signal,
        });
        const description = result.content.trim();
        if (!description) return null;
        if (this.cacheEnabled) {
          if (this.cache.size >= CACHE_LIMIT && !this.cache.has(cacheKey)) this.cache.clear();
          this.cache.set(cacheKey, description);
        }
        return description;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    } catch {
      return null;
    }
  }

  private cacheKey(bytes: Uint8Array): string {
    const hash = createHash("sha256");
    hash.update(`${this.provider.key ?? this.provider.name}\0${this.modelName}\0${this.cacheNamespace}\0`);
    hash.update(bytes);
    return hash.digest("hex");
  }
}

function normalizeImageMime(mime: string): string {
  const normalized = mime.trim().toLowerCase();
  return normalized.startsWith("image/") ? normalized : "image/png";
}

/** ModelProviderConfig（backend-core 超集）→ ProviderConfig（agent-llm 最小集）。 */
export function toProviderConfig(provider: ModelProviderConfig): ProviderConfig {
  const {
    key,
    name,
    provider_type,
    api_endpoint,
    api_key,
    supports_vision,
    supports_function_calling,
    max_completion_tokens,
    temperature,
    ...rest
  } = provider;
  return {
    key: key ?? null,
    name,
    provider_type,
    ...(api_endpoint ? { api_endpoint } : {}),
    ...(api_key ? { api_key } : {}),
    ...(supports_vision !== undefined ? { supports_vision } : {}),
    ...(supports_function_calling !== undefined ? { supports_function_calling } : {}),
    ...(max_completion_tokens !== undefined ? { max_completion_tokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...rest,
  };
}
