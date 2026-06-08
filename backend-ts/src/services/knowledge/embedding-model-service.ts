import type {
  EmbeddingModelInfo,
  EmbeddingModelStats,
  EmbeddingSyncStatus,
  SyncEmbeddingModelRequest,
} from "../../contracts/embedding-models.js";
import type { VectorLibraryService } from "./vector-library-service.js";

export class EmbeddingModelServiceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "EmbeddingModelServiceError";
    this.statusCode = statusCode;
  }
}

export class EmbeddingModelService {
  private activeModelId: number | null = null;

  constructor(private readonly vectorLibrary: VectorLibraryService) {}

  listModels(): EmbeddingModelInfo[] {
    const models = this.vectorLibrary.listVectorizers().flatMap((vectorizer, index) => {
      if (vectorizer.model_id == null) {
        return [];
      }
      const modelId = vectorizer.model_id;
      const isActive = this.activeModelId !== null ? this.activeModelId === modelId : false;
      return [
        {
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
          stats: this.buildStats({
            id: modelId,
            provider: vectorizer.provider_key,
            modelName: vectorizer.model_name,
            dimension: vectorizer.vector_dimension ?? 0,
            isActive,
          }),
        } satisfies EmbeddingModelInfo,
      ];
    });

    if (this.activeModelId !== null && !models.some((model) => model.id === this.activeModelId)) {
      this.activeModelId = null;
    }
    return models;
  }

  activateModel(modelId: number, options: { missingOk?: boolean } = {}): { message: string } {
    const model = this.getModel(modelId);
    if (!model) {
      if (options.missingOk) {
        this.activeModelId = modelId;
        return { message: `模型 ${modelId} 已激活` };
      }
      throw new EmbeddingModelServiceError(`模型不存在: ${modelId}`, 404);
    }
    this.activeModelId = modelId;
    this.vectorLibrary.activateVectorizer(model.vectorizer_key);
    return { message: `模型 ${modelId} 已激活` };
  }

  deleteModel(modelId: number, force: boolean): { message: string } {
    const model = this.getModel(modelId);
    if (!model) {
      throw new EmbeddingModelServiceError("删除失败，请检查日志", 400);
    }
    if (model.is_active && !force) {
      throw new EmbeddingModelServiceError("删除失败，请检查日志", 400);
    }
    this.vectorLibrary.deleteVectorizer(model.vectorizer_key);
    if (this.activeModelId === modelId) {
      this.activeModelId = null;
    }
    return { message: `模型 ${modelId} 已删除` };
  }

  getModelStats(modelId: number): EmbeddingModelStats | Record<string, never> {
    const model = this.getModel(modelId);
    if (!model) {
      return {};
    }
    return this.buildStats({
      id: model.id,
      provider: model.provider,
      modelName: model.model_name,
      dimension: model.vector_dimension,
      isActive: model.is_active,
    });
  }

  getSyncStatus(collection: string): EmbeddingSyncStatus[] {
    const models = new Map(this.listModels().map((model) => [model.id, model]));
    return this.vectorLibrary.getSyncStatus(collection).flatMap((status) => {
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

  syncModel(modelId: number, input: SyncEmbeddingModelRequest): Record<string, unknown> {
    return this.vectorLibrary.syncModel(modelId, {
      collection: input.collection,
      limit: input.limit ?? input.batch_size,
    });
  }

  private getModel(modelId: number): EmbeddingModelInfo | null {
    return this.listModels().find((model) => model.id === modelId) ?? null;
  }

  private buildStats(input: {
    id: number;
    provider: string;
    modelName: string;
    dimension: number;
    isActive: boolean;
  }): EmbeddingModelStats {
    const stats = this.vectorLibrary.getModelStats(input.id);
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
