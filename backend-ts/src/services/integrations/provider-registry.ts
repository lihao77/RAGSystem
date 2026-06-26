/**
 * Provider 类型单一信源。
 * 此前 DEFAULT_ENDPOINTS 在 chat client / embedding-client / model-adapter-service 各定义一份、
 * PROVIDER_TYPES 与 OPENAI_COMPATIBLE_TYPES 又各自散落；新增一种 provider 要改三处以上。
 * 现统一由 PROVIDER_TYPE_SPECS 派生所有视图(默认 endpoint、chat 分发种类、是否支持 embedding)。
 * 新增 provider 类型 = 在此追加一条 spec，无需改动任何 client。
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

/** chat 请求分发种类：专有响应 API / Anthropic Messages / OpenAI 兼容 /embeddings；无 chat 能力为 null。 */
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
export const PROVIDER_TYPE_SET = new Set<string>(PROVIDER_TYPES);

/** provider_type → 默认 endpoint（未知类型回退 ""）。 */
export const DEFAULT_ENDPOINTS: Record<string, string> = Object.fromEntries(
  PROVIDER_TYPE_SPECS.map((spec) => [spec.type, spec.defaultEndpoint]),
);

/**走 OpenAI 兼容 chat 路径（/chat/completions）的类型——openai_resp / anthropic 各有专路，不在内。 */
export const OPENAI_COMPATIBLE_TYPES = new Set<string>(
  PROVIDER_TYPE_SPECS.filter((spec) => spec.chatKind === "openai_compatible").map((spec) => spec.type),
);

export function providerDefaultEndpoint(providerType: string): string {
  return SPEC_BY_TYPE.get(providerType)?.defaultEndpoint ?? "";
}

/** embedding endpoint 默认值：仅 embedding-capable 类型有默认，其余返回 ""（保持原 embedding-client 语义）。 */
export function providerEmbeddingDefaultEndpoint(providerType: string): string {
  const spec = SPEC_BY_TYPE.get(providerType);
  return spec?.supportsEmbedding ? spec.defaultEndpoint : "";
}
