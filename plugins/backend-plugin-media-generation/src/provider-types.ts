/**
 * 媒体生成厂商清单（插件自管 Provider：凭证/端点/模型全在插件配置段，
 * 不进 core 的 Provider 体系——媒体是插件自有概念）。
 * vendor 即 adapter id，与 providers/registry 的 adapter 一一对应。
 */
export type MediaAdapterId = "zhipu" | "volcengine" | "dashscope" | "modelscope" | "openai" | "google";

export interface MediaVendorInfo {
  value: MediaAdapterId;
  label: string;
  /** 厂商 API 根（插件配置 api_endpoint 留空时使用）。 */
  defaultEndpoint: string;
}

export const MEDIA_VENDORS: readonly MediaVendorInfo[] = [
  { value: "zhipu", label: "智谱（BigModel）", defaultEndpoint: "https://open.bigmodel.cn" },
  { value: "volcengine", label: "火山方舟（Ark）", defaultEndpoint: "https://ark.cn-beijing.volces.com" },
  { value: "dashscope", label: "阿里百炼（DashScope）", defaultEndpoint: "https://dashscope.aliyuncs.com" },
  { value: "modelscope", label: "魔搭社区（ModelScope，仅生图）", defaultEndpoint: "https://api-inference.modelscope.cn" },
  { value: "openai", label: "OpenAI", defaultEndpoint: "https://api.openai.com/v1" },
  { value: "google", label: "Google", defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta" },
];

export function findMediaVendor(value: string): MediaVendorInfo | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return MEDIA_VENDORS.find((vendor) => vendor.value === normalized) ?? null;
}
