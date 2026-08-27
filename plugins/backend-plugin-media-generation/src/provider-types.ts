import type { ModelProviderConfig, ProviderTypeInfo } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";

/** 媒体生成适配器 id（与 providers/registry 的 adapter 一一对应）。 */
export type MediaAdapterId = "zhipu" | "volcengine" | "dashscope" | "modelscope" | "openai" | "google";

/** 模型映射任务键（类型注册的 model_map 任务类型）。 */
export const IMAGE_MODEL_TASK = "image";
export const VIDEO_MODEL_TASK = "video";

const MEDIA_MODEL_TASKS: ReadonlyArray<{ value: string; label: string }> = [
  { value: IMAGE_MODEL_TASK, label: "生图模型" },
  { value: VIDEO_MODEL_TASK, label: "生视频模型" },
];

const TIMEOUT_FIELD: ProviderTypeInfo["config_fields"][number] = {
  key: "timeout",
  label: "请求超时（秒）",
  type: "number",
  default: 120,
  min: 5,
  help: "单次 API 请求（提交/查询/下载）的超时时间。",
  options: [],
};

/**
 * 插件注册的 provider type：按厂商一型（类型即 adapter 路由 + 默认 Endpoint），
 * 类型声明自己的模型映射任务（image / video）——Provider 页面创建该类型条目时，
 * 模型映射按"生图模型 / 生视频模型"任务配置模型名，一个条目可同时配两类。
 */
export const MEDIA_PROVIDER_TYPES: readonly ProviderTypeInfo[] = [
  {
    value: "media_zhipu",
    label: "智谱 · 媒体生成",
    default_endpoint: "https://open.bigmodel.cn",
    supports_embedding: false,
    supports_rerank: false,
    config_fields: [TIMEOUT_FIELD],
    model_tasks: MEDIA_MODEL_TASKS,
  },
  {
    value: "media_ark",
    label: "火山方舟 · 媒体生成",
    default_endpoint: "https://ark.cn-beijing.volces.com",
    supports_embedding: false,
    supports_rerank: false,
    config_fields: [TIMEOUT_FIELD],
    model_tasks: MEDIA_MODEL_TASKS,
  },
  {
    value: "media_dashscope",
    label: "阿里百炼 · 媒体生成",
    default_endpoint: "https://dashscope.aliyuncs.com",
    supports_embedding: false,
    supports_rerank: false,
    config_fields: [TIMEOUT_FIELD],
    model_tasks: MEDIA_MODEL_TASKS,
  },
  {
    value: "media_modelscope",
    label: "魔搭社区 · 媒体生成（仅生图）",
    default_endpoint: "https://api-inference.modelscope.cn",
    supports_embedding: false,
    supports_rerank: false,
    config_fields: [TIMEOUT_FIELD],
    model_tasks: MEDIA_MODEL_TASKS,
  },
  {
    value: "media_openai",
    label: "OpenAI · 媒体生成",
    default_endpoint: "https://api.openai.com/v1",
    supports_embedding: false,
    supports_rerank: false,
    config_fields: [TIMEOUT_FIELD],
    model_tasks: MEDIA_MODEL_TASKS,
  },
  {
    value: "media_google",
    label: "Google · 媒体生成",
    default_endpoint: "https://generativelanguage.googleapis.com/v1beta",
    supports_embedding: false,
    supports_rerank: false,
    config_fields: [TIMEOUT_FIELD],
    model_tasks: MEDIA_MODEL_TASKS,
  },
];


/** provider_type → adapter 的权威映射（类型即厂商）。 */
export const PROVIDER_TYPE_TO_ADAPTER: Readonly<Record<string, MediaAdapterId>> = {
  media_zhipu: "zhipu",
  media_ark: "volcengine",
  media_dashscope: "dashscope",
  media_modelscope: "modelscope",
  media_openai: "openai",
  media_google: "google",
};

export const MEDIA_PROVIDER_TYPE_VALUES: readonly string[] = Object.keys(PROVIDER_TYPE_TO_ADAPTER);

export function isMediaProviderType(providerType: string): boolean {
  return PROVIDER_TYPE_TO_ADAPTER.hasOwnProperty(String(providerType ?? "").trim().toLowerCase());
}

export function adapterIdForProviderType(providerType: string): MediaAdapterId | null {
  return PROVIDER_TYPE_TO_ADAPTER[String(providerType ?? "").trim().toLowerCase()] ?? null;
}

/** 能力 → 该类型下的模型映射任务键。 */
export function modelTaskForKind(kind: "image" | "video"): "image" | "video" {
  return kind;
}

/** 条目某任务的模型列表（model_map[task] 归一为数组）。 */
export function modelsForTask(provider: ModelProviderConfig, task: string): string[] {
  const value = provider.model_map?.[task];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  const single = typeof value === "string" ? value.trim() : "";
  return single ? [single] : [];
}
