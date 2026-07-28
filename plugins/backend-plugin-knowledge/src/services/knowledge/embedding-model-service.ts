import type {
  EmbeddingModelInfo,
  EmbeddingModelStats,
  EmbeddingSyncStatus,
  SyncEmbeddingModelRequest,
} from "../../contracts/knowledge/embedding-models.js";
import type { VectorizerConfig } from "../../contracts/knowledge/knowledge-base.js";

export interface EmbeddingModelKnowledgePort {
  listVectorizers(): Promise<VectorizerConfig[]>;
  activateVectorizer(key: string): Promise<unknown>;
  deleteVectorizer(key: string): Promise<unknown>;
  getModelStats(modelId: number): Promise<{ vector_count: number; storage_size_mb: number; collections: Record<string, number> }>;
  getSyncStatus(collection: string): Promise<Array<{ model_id: number; vectorizer_key: string; total_documents: number; synced_documents: number; pending_documents: number; sync_percentage: number }>>;
  syncModel(modelId: number, input: { collection: string; limit?: number | null }): Promise<Record<string, unknown>>;
}

export class EmbeddingModelServiceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "EmbeddingModelServiceError";
    this.statusCode = statusCode;
  }
}

export class EmbeddingModelService {
  constructor(private readonly knowledgeBase: EmbeddingModelKnowledgePort) {}

  async listModels(): Promise<EmbeddingModelInfo[]> {
    const models: EmbeddingModelInfo[] = [];
    for (const vectorizer of await this.knowledgeBase.listVectorizers()) {
      if (vectorizer.model_id == null) {
        continue;
      }
      const modelId = vectorizer.model_id;
      const isActive = vectorizer.is_active;
      models.push({
        id: modelId,
        model_key: this.modelKey(vectorizer.provider_key, vectorizer.model_name, vectorizer.vector_dimension ?? 0),
        provider: vectorizer.provider_key,
        model_name: vectorizer.model_name,
        vector_dimension: vectorizer.vector_dimension ?? 0,
        distance_metric: vectorizer.distance_metric,
        is_active: isActive,
        api_endpoint: null,
        created_at: vectorizer.created_at,
        last_used_at: vectorizer.created_at,
        vectorizer_key: vectorizer.vectorizer_key,
        stats: await this.buildStats({
          id: modelId,
          provider: vectorizer.provider_key,
          modelName: vectorizer.model_name,
          dimension: vectorizer.vector_dimension ?? 0,
          isActive,
        }),
      });
    }

    return models;
  }

  async activateModel(modelId: number, options: { missingOk?: boolean } = {}): Promise<{ message: string }> {
    const model = await this.getModel(modelId);
    if (!model) {
      if (options.missingOk) {
        return { message: `模型 ${modelId} 已激活` };
      }
      throw new EmbeddingModelServiceError(`模型不存在: ${modelId}`, 404);
    }
    await this.knowledgeBase.activateVectorizer(model.vectorizer_key);
    return { message: `模型 ${modelId} 已激活` };
  }

  async deleteModel(modelId: number, force: boolean): Promise<{ message: string }> {
    const model = await this.getModel(modelId);
    if (!model) {
      throw new EmbeddingModelServiceError("删除失败，请检查日志", 400);
    }
    if (model.is_active && !force) {
      throw new EmbeddingModelServiceError("删除失败，请检查日志", 400);
    }
    await this.knowledgeBase.deleteVectorizer(model.vectorizer_key);
    return { message: `模型 ${modelId} 已删除` };
  }

  async getModelStats(modelId: number): Promise<EmbeddingModelStats | Record<string, never>> {
    const model = await this.getModel(modelId);
    if (!model) {
      return {};
    }
    return await this.buildStats({
      id: model.id,
      provider: model.provider,
      modelName: model.model_name,
      dimension: model.vector_dimension,
      isActive: model.is_active,
    });
  }

  async getSyncStatus(collection: string): Promise<EmbeddingSyncStatus[]> {
    const models = new Map((await this.listModels()).map((model) => [model.id, model]));
    return (await this.knowledgeBase.getSyncStatus(collection)).flatMap((status) => {
      const model = models.get(status.model_id);
      if (!model) {
        return [];
      }
      return [{
        model_id: status.model_id,
        model_key: model.model_key,
        is_active: model.is_active,
        total_documents: status.total_documents,
        synced_documents: status.synced_documents,
        pending_documents: status.pending_documents,
        sync_percentage: status.sync_percentage,
      }];
    });
  }

  async syncModel(modelId: number, input: SyncEmbeddingModelRequest): Promise<Record<string, unknown>> {
    return this.knowledgeBase.syncModel(modelId, {
      collection: input.collection,
      limit: input.limit ?? input.batch_size,
    });
  }

  private async getModel(modelId: number): Promise<EmbeddingModelInfo | null> {
    return (await this.listModels()).find((model) => model.id === modelId) ?? null;
  }

  private async buildStats(input: {
    id: number;
    provider: string;
    modelName: string;
    dimension: number;
    isActive: boolean;
  }): Promise<EmbeddingModelStats> {
    const stats = await this.knowledgeBase.getModelStats(input.id);
    return {
      model_id: input.id,
      model_key: this.modelKey(input.provider, input.modelName, input.dimension),
      provider: input.provider,
      model_name: input.modelName,
      vector_dimension: input.dimension,
      is_active: input.isActive,
      vector_count: stats.vector_count,
      storage_size_mb: stats.storage_size_mb,
      collections: stats.collections,
    };
  }

  private modelKey(provider: string, modelName: string, dimension: number): string {
    return `${provider}_${modelName}_${dimension}`;
  }
}
