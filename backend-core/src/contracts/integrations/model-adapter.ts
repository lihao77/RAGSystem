import { z } from "zod";

export const ProviderPayloadSchema = z.record(z.unknown());

export const ReorderProvidersRequestSchema = z.object({
  provider_keys: z.array(z.string()),
});

export const TestProviderRequestSchema = z
  .object({
    provider: z.string().optional(),
    provider_type: z.string().optional(),
    model: z.union([z.string(), z.array(z.string())]).optional(),
    prompt: z.string().optional(),
  })
  .catchall(z.unknown());

export interface ProviderConfigFieldOption {
  value: string;
  label: string;
}

export interface ProviderConfigField {
  key: string;
  label: string;
  type: string;
  default: string | number | boolean | null;
  help: string;
  options: ProviderConfigFieldOption[];
  min?: number;
  max?: number;
  step?: number;
}

export interface ProviderTypeInfo {
  value: string;
  label: string;
  default_endpoint: string;
  config_fields: ProviderConfigField[];
}

/**
 * Provider 下的单个模型条目：运行参数与能力位挂在模型上（同厂商不同模型参数各异），
 * Provider 条目本身只承载连接信息（endpoint/key/超时重试/协议级缓存开关）。
 */
export interface ProviderModelEntry {
  name: string;
  temperature?: number;
  max_completion_tokens?: number;
  max_context_tokens?: number;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
}

export type ProviderPayload = z.infer<typeof ProviderPayloadSchema>;
export type ReorderProvidersRequest = z.infer<typeof ReorderProvidersRequestSchema>;
export type TestProviderRequest = z.infer<typeof TestProviderRequestSchema>;

export interface ModelProviderConfig {
  name: string;
  provider_type: string;
  key?: string;
  api_key?: string;
  api_key_configured?: boolean;
  api_endpoint?: string;
  models: ProviderModelEntry[];
  /** Provider connection/first-response and stream idle timeout, in seconds. */
  timeout?: number;
  retry_attempts?: number;
  retry_delay?: number;
  retry_backoff_factor?: number;
  /** Provider prompt cache 总开关；各协议只发送自身支持的缓存字段。 */
  supports_prompt_caching?: boolean;
  /** provider KV cache 有效期(秒);注入上下文快照的 sliding 失效阈值。 */
  cache_ttl_seconds?: number;
  is_loaded?: boolean;
  is_available?: boolean;
  [key: string]: unknown;
}

/**
 * Runtime provider catalog exposed to plugins.
 *
 * Provider administration and request execution remain owned by Core's model
 * adapter service; plugins only need this read-only lookup surface.
 */
export interface ModelProviderCatalogPort {
  hasProvider(providerKey: string): boolean;
  getProvider(providerKey: string): ModelProviderConfig | null;
  /** 全部已加载 provider（只读克隆；插件按 key/name 匹配模型用）。 */
  listProviders(): ModelProviderConfig[];
}
