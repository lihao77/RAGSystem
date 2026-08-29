/**
 * 知识库插件自管模型 Provider（embedding / rerank）：凭证与端点存在插件自己的存储里，
 * 与 core 的模型 Provider 体系完全无关（外来概念不进内核）。
 *
 * 形态为 OpenAI 兼容 HTTP API（POST {endpoint}/embeddings 与 /rerank）。
 */
export type KnowledgeModelProviderKind = "embedding" | "rerank";

export interface KnowledgeModelProvider {
  provider_key: string;
  kind: KnowledgeModelProviderKind;
  name: string;
  api_endpoint: string;
  /** 落库存储；API 输出经脱敏（api_key_configured）。支持 ${ENV_VAR} 占位符（客户端解析）。 */
  api_key: string;
  model_name: string;
  is_active: boolean;
  created_at?: string;
}

/** API 对外形态（不含密钥明文）。 */
export interface KnowledgeModelProviderInfo extends Omit<KnowledgeModelProvider, "api_key"> {
  api_key_configured: boolean;
}

export interface KnowledgeModelProviderStore {
  listProviders(tenantId: string): Promise<KnowledgeModelProvider[]>;
  getProvider(tenantId: string, providerKey: string): Promise<KnowledgeModelProvider | null>;
  /** 新建或按 key 覆盖（api_key 传 null 表示保留原值）。 */
  upsertProvider(tenantId: string, provider: KnowledgeModelProvider, options?: { keepExistingApiKey?: boolean }): Promise<KnowledgeModelProvider>;
  deleteProvider(tenantId: string, providerKey: string): Promise<void>;
}

/* ── 插件自管的 embedding / rerank HTTP 客户端口（原 core 客户端随概念一并搬入插件） ── */

export interface EmbeddingRequest {
  texts: string[];
  model: string;
  provider: KnowledgeModelProvider;
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
