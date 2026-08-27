import { z } from "zod";

export const ModelMapValueSchema = z.union([z.string(), z.array(z.string())]);
export const ModelMapSchema = z.record(ModelMapValueSchema);

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
    task: z.string().optional().default("chat"),
    documents: z.array(z.unknown()).optional(),
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

/** 插件注册的模型映射任务类型（provider 条目 model_map 的自定义任务键）。 */
export interface ProviderModelTaskInfo {
  value: string;
  label: string;
}

export interface ProviderTypeInfo {
  value: string;
  label: string;
  default_endpoint: string;
  supports_embedding: boolean;
  supports_rerank: boolean;
  config_fields: ProviderConfigField[];
  /** 该类型条目可配置的模型映射任务（插件类型声明，自带 label；内置类型缺省 chat/embedding/rerank）。 */
  model_tasks?: readonly ProviderModelTaskInfo[];
  /** 插件贡献的类型：来源插件 manifest id；内置类型无此字段。 */
  extension_id?: string;
}

/** 插件注册的 Provider 类型（宿主盖章 extension_id 后的形态）。 */
export interface RegisteredProviderType extends ProviderTypeInfo {
  extension_id: string;
}

export type ModelMapValue = z.infer<typeof ModelMapValueSchema>;
export type ModelMap = z.infer<typeof ModelMapSchema>;
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
  model?: string;
  models: string[];
  model_map: ModelMap;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  max_context_tokens?: number;
  /** Provider connection/first-response and stream idle timeout, in seconds. */
  timeout?: number;
  retry_attempts?: number;
  retry_delay?: number;
  retry_backoff_factor?: number;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
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
  createEmbeddingClient(): EmbeddingClientPort;
  createRerankClient(): RerankClientPort;
}

export interface EmbeddingRequest {
  texts: string[];
  model: string;
  provider: ModelProviderConfig;
}

export interface EmbeddingClientPort {
  embed(request: EmbeddingRequest): Promise<number[][]>;
}

export interface RerankRequest {
  query: string;
  documents: string[];
  reranker: {
    reranker_key: string;
    model_name: string;
    api_endpoint: string;
    api_key: string | null;
  };
  topN?: number | undefined;
}

export interface RerankClientPort {
  rerank(request: RerankRequest): Promise<number[]>;
}
