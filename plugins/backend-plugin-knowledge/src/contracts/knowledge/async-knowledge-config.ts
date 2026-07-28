import type { CreateRerankerInput, CreateVectorizerInput, StoredReranker, StoredVectorizer } from "../vector-store/knowledge-config.js";

/** Tenant-scoped asynchronous knowledge configuration shared by all runtimes. */
export interface AsyncKnowledgeConfigStore {
  listVectorizers(tenantId: string): Promise<StoredVectorizer[]>;
  getVectorizerByKey(tenantId: string, key: string): Promise<StoredVectorizer | null>;
  createVectorizer(tenantId: string, input: CreateVectorizerInput): Promise<StoredVectorizer>;
  setVectorDimension(tenantId: string, key: string, dimension: number): Promise<void>;
  activateVectorizer(tenantId: string, key: string): Promise<void>;
  deleteVectorizer(tenantId: string, key: string): Promise<{ next_active_key: string | null }>;
  listRerankers(tenantId: string): Promise<StoredReranker[]>;
  getReranker(tenantId: string, key: string): Promise<StoredReranker | null>;
  createReranker(tenantId: string, input: CreateRerankerInput): Promise<StoredReranker>;
  activateReranker(tenantId: string, key: string): Promise<void>;
  deleteReranker(tenantId: string, key: string): Promise<{ next_active_key: string | null }>;
}
