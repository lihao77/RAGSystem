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
  uploaded_at: string;
  size: number;
  mime: string;
}

export interface VectorFileStatusResponse {
  files: VectorFileStatus[];
  vectorizers: FileStatusVectorizer[];
}

export interface RerankerConfig {
  reranker_key: string;
  mode: "model" | "lexical" | "none";
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  api_endpoint: string;
  created_at: string;
  is_active: boolean;
  api_key?: string;
}
