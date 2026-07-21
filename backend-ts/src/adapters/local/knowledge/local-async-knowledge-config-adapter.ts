import type { AsyncKnowledgeConfigStore } from "../../../contracts/knowledge/async-knowledge-config.js";
import type {
  CreateRerankerInput,
  CreateVectorizerInput,
  IKnowledgeConfig,
  StoredReranker,
  StoredVectorizer,
} from "../../../contracts/vector-store/index.js";

/** Promise-based view over the tenant-bound Local knowledge configuration. */
export class LocalAsyncKnowledgeConfigAdapter implements AsyncKnowledgeConfigStore {
  constructor(private readonly config: IKnowledgeConfig) {}

  async listVectorizers(_tenantId: string): Promise<StoredVectorizer[]> {
    return this.config.listVectorizers();
  }

  async getVectorizerByKey(_tenantId: string, key: string): Promise<StoredVectorizer | null> {
    return this.config.getVectorizerByKey(key);
  }

  async createVectorizer(_tenantId: string, input: CreateVectorizerInput): Promise<StoredVectorizer> {
    return this.config.createVectorizer(input);
  }

  async setVectorDimension(_tenantId: string, key: string, dimension: number): Promise<void> {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new Error("vector dimension must be a positive integer");
    }
    const vectorizer = this.config.getVectorizerByKey(key);
    if (!vectorizer) {
      throw new Error(`vectorizer not found: ${key}`);
    }
    if (vectorizer.vector_dimension !== null && vectorizer.vector_dimension !== dimension) {
      throw new Error(`vectorizer dimension mismatch: ${key}`);
    }
    // Local SQLite persists the physical dimension when the first vector batch is upserted.
  }

  async activateVectorizer(_tenantId: string, key: string): Promise<void> {
    this.config.activateVectorizer(key);
  }

  async deleteVectorizer(_tenantId: string, key: string): Promise<{ next_active_key: string | null }> {
    return this.config.deleteVectorizer(key);
  }

  async listRerankers(_tenantId: string): Promise<StoredReranker[]> {
    return this.config.listRerankers();
  }

  async getReranker(_tenantId: string, key: string): Promise<StoredReranker | null> {
    return this.config.getReranker(key);
  }

  async createReranker(_tenantId: string, input: CreateRerankerInput): Promise<StoredReranker> {
    return this.config.createReranker(input);
  }

  async activateReranker(_tenantId: string, key: string): Promise<void> {
    this.config.activateReranker(key);
  }

  async deleteReranker(_tenantId: string, key: string): Promise<{ next_active_key: string | null }> {
    return this.config.deleteReranker(key);
  }
}
