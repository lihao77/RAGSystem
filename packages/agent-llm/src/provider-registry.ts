/**
 * Provider API 格式单一信源（纯协议方言，封闭 5 种；厂商适配不在此层——
 * 思考形状经 provider 的 thinking_kind 声明、静态厂商参数经 extra_params 进请求体）。
 *
 * 纯数据，无产品依赖。DEFAULT_ENDPOINTS / OPENAI_COMPATIBLE_TYPES 等视图由 PROVIDER_TYPE_SPECS
 * 派生，新增协议格式 = 追加一条 spec，无需改任何 client。
 */

export type ProviderType =
  | "openai_resp"
  | "openai_chat"
  | "openai_proxy"
  | "anthropic"
  | "gemini";

/** Chat request dispatch kind; null means the provider has no chat capability. */
export type ChatDispatchKind = "openai_responses" | "anthropic" | "gemini" | "openai_compatible" | null;

/** Prompt cache protocol shape; named_content is reserved for managed cache resources. */
export type PromptCacheMode = "none" | "automatic_prefix" | "explicit_blocks" | "named_content";

/** Provider usage response format. */
export type UsageFormat = "openai" | "anthropic" | "gemini" | "none";

/** Whether native function calling is unavailable, configurable, or always selected. */
export type NativeFunctionCallingMode = "none" | "configurable" | "always";

export interface ProviderTypeSpec {
  type: ProviderType;
  defaultEndpoint: string;
  chatKind: ChatDispatchKind;
  promptCacheMode: PromptCacheMode;
  usageFormat: UsageFormat;
  supportsPromptCacheKey: boolean;
  supportsPromptCacheTtl: boolean;
  exposesPromptCacheToggle: boolean;
  supportsStreamUsageOptions: boolean;
  nativeFunctionCalling: NativeFunctionCallingMode;
}

export const PROVIDER_TYPE_SPECS: readonly ProviderTypeSpec[] = [
  {
    type: "openai_resp", defaultEndpoint: "https://api.openai.com/v1", chatKind: "openai_responses",
    promptCacheMode: "automatic_prefix", usageFormat: "openai", supportsPromptCacheKey: true,
    supportsPromptCacheTtl: false, exposesPromptCacheToggle: false, supportsStreamUsageOptions: true, nativeFunctionCalling: "configurable",
  },
  {
    type: "openai_chat", defaultEndpoint: "https://api.openai.com/v1", chatKind: "openai_compatible",
    promptCacheMode: "automatic_prefix", usageFormat: "openai", supportsPromptCacheKey: true,
    supportsPromptCacheTtl: false, exposesPromptCacheToggle: false, supportsStreamUsageOptions: true, nativeFunctionCalling: "configurable",
  },
  {
    type: "openai_proxy", defaultEndpoint: "https://api.openai.com/v1", chatKind: "openai_compatible",
    promptCacheMode: "none", usageFormat: "openai", supportsPromptCacheKey: false,
    supportsPromptCacheTtl: false, exposesPromptCacheToggle: false, supportsStreamUsageOptions: true, nativeFunctionCalling: "configurable",
  },
  {
    type: "anthropic", defaultEndpoint: "https://api.anthropic.com", chatKind: "anthropic",
    promptCacheMode: "explicit_blocks", usageFormat: "anthropic", supportsPromptCacheKey: false,
    supportsPromptCacheTtl: true, exposesPromptCacheToggle: true, supportsStreamUsageOptions: false, nativeFunctionCalling: "always",
  },
  {
    type: "gemini", defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta", chatKind: "gemini",
    promptCacheMode: "automatic_prefix", usageFormat: "gemini", supportsPromptCacheKey: false,
    supportsPromptCacheTtl: false, exposesPromptCacheToggle: false, supportsStreamUsageOptions: false, nativeFunctionCalling: "configurable",
  },
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

/** provider_type -> complete capability description; unknown types return null. */
export function providerTypeSpec(providerType: string): ProviderTypeSpec | null {
  return SPEC_BY_TYPE.get(providerType) ?? null;
}

/** Whether this provider configuration should use the native function-calling protocol. */
export function providerUsesNativeFunctionCalling(providerType: string, enabled: boolean | null | undefined): boolean {
  const mode = SPEC_BY_TYPE.get(providerType)?.nativeFunctionCalling ?? "none";
  return mode === "always" || (mode === "configurable" && enabled === true);
}
