/**
 * 知识库配置面契约:vectorizer/reranker 实体注册 + is_active 激活态。
 *
 * 设计决策:
 * - 与 IVectorStore(数据面)分离:演进频率不同,实现可拆(未来 Qdrant driver 可只实现 IVectorStore,配置面另存)。
 * - is_active 列直接挂 vectorizers/rerankers 表(partial UNIQUE index 保证全局单例),
 *   替代旧的 vector_settings KV 表 + 内存 activeXxxKey 副本 + YAML 字段三处分裂。
 * - driver 是单一可信源,service 通过此契约代理,不再直接 SQL。
 *
 * 深合约:
 * - createVectorizer 返回含 model_id(自增)、created_at(ISO now)、vector_dimension=null(占位,首次 index 后更新)、is_active(空表时自动激活,否则 false);
 * - activateVectorizer 不存在 → 抛 VectorStoreError(深合约前置违反,编排层翻译 HTTP 404);
 * - deleteVectorizer 内部事务包"删实体 + clear is_active + 回退 next_active + deleteByModel(清向量)",
 *   返回 next_active_key 供编排层回写内存(若 driver 自己已维护则可忽略);
 * - listVectorizers/listRerankers 空表返 [] 不抛异常。
 */

import type { RerankerMode } from "../knowledge/knowledge-base.js";

/** reranker 模式:model=模型重排;lexical=词法重排(BM25 等);none=无重排透传。 */
export type { RerankerMode };

export interface StoredVectorizer {
  model_id: number;
  vectorizer_key: string;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  distance_metric: string;
  created_at: string;
  /** 占位 null,首次 index 后由 driver 根据 vec_chunks_${model_id} 实际维度更新。 */
  vector_dimension: number | null;
  is_active: boolean;
}

export interface StoredReranker {
  reranker_key: string;
  mode: RerankerMode;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  api_endpoint: string;
  /** 仅落 DB,不入任何 YAML。编排层读取后用完即弃,不回显给未授权客户端。 */
  api_key: string | null;
  created_at: string;
  is_active: boolean;
}

export interface CreateVectorizerInput {
  vectorizer_key: string;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  distance_metric: string;
}

export interface CreateRerankerInput {
  reranker_key: string;
  mode: RerankerMode;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  api_endpoint: string;
  api_key: string | null;
}

export interface IKnowledgeConfig {
  // vectorizer 配置面
  listVectorizers(): StoredVectorizer[];
  getVectorizerByKey(key: string): StoredVectorizer | null;
  getVectorizerByModelId(modelId: number): StoredVectorizer | null;
  createVectorizer(input: CreateVectorizerInput): StoredVectorizer;
  /** 同时清理该 model_id 的所有向量(vec_chunks_${model_id})。返回回退后的激活 key(可能 null)。 */
  deleteVectorizer(key: string): { next_active_key: string | null };
  activateVectorizer(key: string): void;

  // reranker 配置面
  listRerankers(): StoredReranker[];
  getReranker(key: string): StoredReranker | null;
  createReranker(input: CreateRerankerInput): StoredReranker;
  deleteReranker(key: string): { next_active_key: string | null };
  activateReranker(key: string): void;
}
