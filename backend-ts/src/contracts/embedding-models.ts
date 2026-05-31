import { z } from "zod";

export const SyncEmbeddingModelRequestSchema = z
  .object({
    collection: z.string().trim().optional().default("default"),
    batch_size: z.number().int().positive().optional().default(50),
    limit: z.number().int().positive().nullable().optional(),
  })
  .catchall(z.unknown());

export type SyncEmbeddingModelRequest = z.infer<typeof SyncEmbeddingModelRequestSchema>;

export interface EmbeddingModelStats {
  model_id: number;
  model_key: string;
  provider: string;
  model_name: string;
  vector_dimension: number;
  is_active: boolean;
  vector_count: number;
  storage_size_mb: number;
  collections: Record<string, number>;
}

export interface EmbeddingModelInfo {
  id: number;
  model_key: string;
  provider: string;
  model_name: string;
  vector_dimension: number;
  distance_metric: string;
  is_active: boolean;
  api_endpoint: string | null;
  created_at: string;
  last_used_at: string;
  vectorizer_key: string;
  stats?: EmbeddingModelStats;
}

export interface EmbeddingSyncStatus {
  model_id: number;
  model_key: string;
  is_active: boolean;
  total_documents: number;
  synced_documents: number;
  pending_documents: number;
  sync_percentage: number;
}
