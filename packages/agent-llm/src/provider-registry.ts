/**
 * Provider 类型单一信源。
 *
 * 纯数据，无产品依赖。DEFAULT_ENDPOINTS / OPENAI_COMPATIBLE_TYPES 等视图由 PROVIDER_TYPE_SPECS
 * 派生，新增 provider 类型 = 追加一条 spec，无需改任何 client。
 */

export type ProviderType =
  | "openai_resp"
  | "openai_chat"
  | "openai_proxy"
  | "anthropic"
  | "deepseek"
  | "openrouter"
  | "modelscope"
  | "rerank_api";

/** chat 请求分发种类：专有响应 API / Anthropic Messages / OpenAI 兼容；无 chat 能力为 null。 */
export type ChatDispatchKind = "openai_responses" | "anthropic" | "openai_compatible" | null;

export interface ProviderTypeSpec {
  type: ProviderType;
  defaultEndpoint: string;
  chatKind: ChatDispatchKind;
  supportsEmbedding: boolean;
}

export const PROVIDER_TYPE_SPECS: readonly ProviderTypeSpec[] = [
  { type: "openai_resp", defaultEndpoint: "https://api.openai.com/v1", chatKind: "openai_responses", supportsEmbedding: true },
  { type: "openai_chat", defaultEndpoint: "https://api.openai.com/v1", chatKind: "openai_compatible", supportsEmbedding: true },
  { type: "openai_proxy", defaultEndpoint: "https://api.openai.com/v1", chatKind: "openai_compatible", supportsEmbedding: true },
  { type: "anthropic", defaultEndpoint: "https://api.anthropic.com", chatKind: "anthropic", supportsEmbedding: false },
  { type: "deepseek", defaultEndpoint: "https://api.deepseek.com/v1", chatKind: "openai_compatible", supportsEmbedding: true },
  { type: "openrouter", defaultEndpoint: "https://openrouter.ai/api/v1", chatKind: "openai_compatible", supportsEmbedding: true },
  { type: "modelscope", defaultEndpoint: "https://api-inference.modelscope.cn/v1", chatKind: "openai_compatible", supportsEmbedding: true },
  { type: "rerank_api", defaultEndpoint: "", chatKind: null, supportsEmbedding: false },
];

const SPEC_BY_TYPE = new Map<string, ProviderTypeSpec>(PROVIDER_TYPE_SPECS.map((spec) => [spec.type, spec]));

export const PROVIDER_TYPES: readonly ProviderType[] = PROVIDER_TYPE_SPECS.map((spec) => spec.type);
export const PROVIDER_TYPE_SET: ReadonlySet<string> = new Set(PROVIDER_TYPES);

/** provider_type → 默认 endpoint（未知类型回退 ""）。 */
export const DEFAULT_ENDPOINTS: Readonly<Record<string, string>> = Object.fromEntries(
  PROVIDER_TYPE_SPECS.map((spec) => [spec.type, spec.defaultEndpoint]),
);

/** 走 OpenAI 兼容 chat 路径（/chat/completions）的类型——openai_resp / anthropic 各有专路，不在内。 */
export const OPENAI_COMPATIBLE_TYPES: ReadonlySet<string> = new Set(
  PROVIDER_TYPE_SPECS.filter((spec) => spec.chatKind === "openai_compatible").map((spec) => spec.type),
);

/** provider_type → 默认 endpoint（未知类型回退 ""）。 */
export function providerDefaultEndpoint(providerType: string): string {
  return SPEC_BY_TYPE.get(providerType)?.defaultEndpoint ?? "";
}

/** embedding endpoint 默认值：仅 embedding-capable 类型有默认，其余返回 ""。 */
export function providerEmbeddingDefaultEndpoint(providerType: string): string {
  const spec = SPEC_BY_TYPE.get(providerType);
  return spec?.supportsEmbedding ? spec.defaultEndpoint : "";
}
