import { z } from "zod";

export const VectorizerCreateSchema = z
  .object({
    provider_key: z.string().trim().min(1),
    model_name: z.string().trim().min(1),
    distance_metric: z.string().trim().optional().default("cosine"),
    vectorizer_key: z.string().trim().optional(),
    provider_type: z.string().trim().nullable().optional(),
  })
  .catchall(z.unknown());

export const IndexFileRequestSchema = z
  .object({
    collection: z.string().trim().min(1),
    file_id: z.string().trim().min(1),
    vectorizer_key: z.string().trim().min(1),
  })
  .catchall(z.unknown());

export const DeleteIndexedFileRequestSchema = z
  .object({
    collection: z.string().trim().min(1),
    file_id: z.string().trim().min(1),
  })
  .catchall(z.unknown());

export const RerankerCreateSchema = z
  .object({
    mode: z.string().trim().optional().default("none"),
    reranker_key: z.string().trim().optional(),
    provider_key: z.string().trim().optional(),
    provider_type: z.string().trim().nullable().optional(),
    model_name: z.string().trim().optional(),
    api_endpoint: z.string().trim().optional(),
    api_key: z.string().optional(),
  })
  .catchall(z.unknown());

export const SearchVectorsRequestSchema = z
  .object({
    query: z.string().trim().min(1),
    top_k: z.number().int().positive().optional(),
    collection: z.string().trim().optional(),
    collection_name: z.string().trim().optional(),
    search_mode: z.enum(["hybrid", "vector"]).optional(),
    mode: z.enum(["hybrid", "vector"]).optional(),
    filters: z.unknown().optional(),
    rerank: z.boolean().optional(),
    rerank_mode: z.string().trim().optional(),
    rerank_top_k: z.number().int().positive().optional(),
    final_top_k: z.number().int().positive().optional(),
    reranker_key: z.string().trim().optional(),
  })
  .catchall(z.unknown());

export const GenericVectorRequestSchema = z.record(z.unknown()).optional().default({});

export type VectorizerCreate = z.infer<typeof VectorizerCreateSchema>;
export type IndexFileRequest = z.infer<typeof IndexFileRequestSchema>;
export type DeleteIndexedFileRequest = z.infer<typeof DeleteIndexedFileRequestSchema>;
export type RerankerCreate = z.infer<typeof RerankerCreateSchema>;
export type SearchVectorsRequest = z.infer<typeof SearchVectorsRequestSchema>;
export type GenericVectorRequest = z.infer<typeof GenericVectorRequestSchema>;

export interface VectorizerConfig {
  vectorizer_key: string;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  distance_metric: string;
  created_at: string;
  is_active: boolean;
  provider_available: boolean;
  vector_dimension: number | null;
  vector_count: number;
  model_id: number | null;
}

export interface FileStatusVectorizer {
  vectorizer_key: string;
  model_name: string;
  provider_key: string;
  dimension: number;
  model_id: number | null;
}

export interface VectorFileStatus {
  file_name: string;
  file_id: string;
  collection: string;
  chunk_count: number;
  vectorizer_status: Record<string, "已索引" | "未索引">;
  uploaded_at?: string;
  size?: number;
  mime?: string;
}

export interface VectorFileStatusResponse {
  files: VectorFileStatus[];
  vectorizers: FileStatusVectorizer[];
}

/** reranker 模式:model=模型重排;lexical=词法重排(BM25 等);none=无重排透传。 */
export type RerankerMode = "model" | "lexical" | "none";

export interface RerankerConfig {
  reranker_key: string;
  mode: RerankerMode;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  api_endpoint: string;
  created_at: string;
  is_active: boolean;
  api_key?: string;
}

/**
 * 向量库服务错误(收编:原定义在 vector-library-service.ts:24-32,契约泄漏)。
 * 被 routes/vector.ts、routes/vector-library.ts 统一用于 HTTP 错误映射(携带 statusCode)。
 * 注:A 类(driver 数据面)错误用 contracts/vector-store 的 VectorStoreError;本类用于 B 类配置面 + 路由层。
 */
export class VectorLibraryServiceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "VectorLibraryServiceError";
    this.statusCode = statusCode;
  }
}

/**
 * 向量检索结果(收编:原定义在 vector-library-service.ts:34-48,被 KnowledgeTools 直接 import 造成契约泄漏)。
 * 这是编排层(VectorLibraryService.search)输出给路由/工具的最终结果,含混合打分。
 * driver 层(VectorStore.search)只产出 VectorSearchHit(仅 vector_score),编排层用 scoring.ts 补混合分后映射为本类型。
 */
export interface VectorSearchResult {
  id: string;
  doc_id: string;
  document_id: string;
  collection: string;
  text: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  similarity: number;
  keyword_score: number;
  vector_score: number;
  hybrid_score: number;
  rerank_score?: number;
}
