/**
 * 知识库配置面 DTO:vectorizer/reranker 实体形状。
 *
 * 行为端口见 contracts/knowledge/async-knowledge-config.ts(AsyncKnowledgeConfigStore)。
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
  /** 占位 null,首次 index 后由 config store 根据实际维度更新。 */
  vector_dimension: number | null;
  is_active: boolean;
}

export interface StoredReranker {
  reranker_key: string;
  mode: RerankerMode;
  provider_key: string;
  provider_type: string | null;
  /** model 模式持久化为空；仅运行时从 Model Provider 水合后赋值。 */
  model_name: string;
  /** model 模式持久化为空；仅运行时从 Model Provider 水合后赋值。 */
  api_endpoint: string;
  /** model 模式持久化为 null；仅运行时从 Model Provider 水合后赋值。 */
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
