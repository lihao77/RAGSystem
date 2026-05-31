import type {
  FileStatusVectorizer,
  RerankerConfig,
  RerankerCreate,
  VectorFileStatus,
  VectorFileStatusResponse,
  VectorizerConfig,
  VectorizerCreate,
} from "../contracts/vector-library.js";
import type { FileIndexService } from "./file-index-service.js";
import type { ModelAdapterService } from "./model-adapter-service.js";

export class VectorLibraryServiceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "VectorLibraryServiceError";
    this.statusCode = statusCode;
  }
}

export class VectorLibraryService {
  private readonly vectorizers = new Map<string, StoredVectorizer>();
  private activeVectorizerKey: string | null = null;
  private readonly rerankers = new Map<string, StoredReranker>();
  private activeRerankerKey: string | null = null;

  constructor(
    private readonly fileIndex: FileIndexService,
    private readonly modelAdapter: ModelAdapterService,
  ) {}

  fileStatus(): VectorFileStatusResponse {
    const vectorizers = this.listFileStatusVectorizers();
    return {
      files: this.fileIndex
        .list({ scopeType: "global", scopeId: null })
        .map((file): VectorFileStatus => {
          const status = Object.fromEntries(
            vectorizers.map((vectorizer) => [
              vectorizer.vectorizer_key,
              file.indexed_in_vector ? "已索引" : "未索引",
            ]),
          ) as Record<string, "已索引" | "未索引">;
          return {
            file_name: file.original_name,
            file_id: file.id,
            collection: "documents",
            chunk_count: 0,
            vectorizer_status: status,
            uploaded_at: file.uploaded_at,
            size: file.size,
            mime: file.mime,
          };
        }),
      vectorizers,
    };
  }

  listVectorizers(): VectorizerConfig[] {
    return Array.from(this.vectorizers.values()).map((vectorizer, index) =>
      this.toVectorizerConfig(vectorizer, index + 1),
    );
  }

  addVectorizer(input: VectorizerCreate): Pick<VectorizerConfig, "vectorizer_key" | "vector_dimension" | "model_id"> {
    const providerKey = input.provider_key.trim();
    const modelName = input.model_name.trim();
    if (!this.modelAdapter.hasProvider(providerKey)) {
      throw new VectorLibraryServiceError(`向量化器引用的 Provider 不存在: ${providerKey}`, 400);
    }

    const key = input.vectorizer_key?.trim() || normalizeVectorizerKey(providerKey, modelName);
    if (this.vectorizers.has(key)) {
      throw new VectorLibraryServiceError(`向量化器键已存在: ${key}`, 400);
    }

    const vectorizer: StoredVectorizer = {
      vectorizer_key: key,
      provider_key: providerKey,
      provider_type: normalizeNullableString(input.provider_type),
      model_name: modelName,
      distance_metric: input.distance_metric || "cosine",
      created_at: new Date().toISOString(),
      vector_dimension: null,
      vector_count: 0,
      model_id: this.vectorizers.size + 1,
    };
    this.vectorizers.set(key, vectorizer);
    if (!this.activeVectorizerKey) {
      this.activeVectorizerKey = key;
    }
    return {
      vectorizer_key: key,
      vector_dimension: vectorizer.vector_dimension,
      model_id: vectorizer.model_id,
    };
  }

  activateVectorizer(key: string): { active_vectorizer_key: string } {
    if (!this.vectorizers.has(key)) {
      throw new VectorLibraryServiceError(`向量化器不存在: ${key}`, 404);
    }
    this.activeVectorizerKey = key;
    return { active_vectorizer_key: key };
  }

  deleteVectorizer(key: string): { deleted_vectorizer_key: string } {
    if (!this.vectorizers.delete(key)) {
      throw new VectorLibraryServiceError(`向量化器不存在: ${key}`, 404);
    }
    if (this.activeVectorizerKey === key) {
      this.activeVectorizerKey = this.vectorizers.keys().next().value ?? null;
    }
    return { deleted_vectorizer_key: key };
  }

  listDocsByVectorizer(key: string): Array<Record<string, unknown>> {
    if (!this.vectorizers.has(key)) {
      throw new VectorLibraryServiceError(`向量化器不存在或未在 DB 注册: ${key}`, 404);
    }
    return [];
  }

  listRerankers(): RerankerConfig[] {
    return Array.from(this.rerankers.values()).map((reranker) => this.toRerankerConfig(reranker));
  }

  addReranker(input: RerankerCreate): { reranker_key: string } {
    const mode = normalizeRerankerMode(input.mode);
    const providerKey = input.provider_key?.trim() || "";
    const modelName = input.model_name?.trim() || "";
    if (mode === "model") {
      if (!providerKey || !modelName) {
        throw new VectorLibraryServiceError("model 模式的重排序器必须提供 provider_key 和 model_name", 400);
      }
      if (!input.api_endpoint?.trim()) {
        throw new VectorLibraryServiceError("model 模式的重排序器必须提供 api_endpoint", 400);
      }
    }

    const key = input.reranker_key?.trim() || normalizeRerankerKey(mode, providerKey, modelName);
    if (this.rerankers.has(key)) {
      throw new VectorLibraryServiceError(`重排序器键已存在: ${key}`, 400);
    }
    const reranker: StoredReranker = {
      reranker_key: key,
      mode,
      provider_key: providerKey,
      provider_type: normalizeNullableString(input.provider_type),
      model_name: modelName,
      api_endpoint: input.api_endpoint?.trim() || "",
      api_key: input.api_key,
      created_at: new Date().toISOString(),
    };
    this.rerankers.set(key, reranker);
    if (!this.activeRerankerKey) {
      this.activeRerankerKey = key;
    }
    return { reranker_key: key };
  }

  getReranker(key: string): RerankerConfig | null {
    const reranker = this.rerankers.get(key);
    return reranker ? this.toRerankerConfig(reranker) : null;
  }

  activateReranker(key: string): { active_reranker_key: string } {
    if (!this.rerankers.has(key)) {
      throw new VectorLibraryServiceError(`重排序器不存在: ${key}`, 404);
    }
    this.activeRerankerKey = key;
    return { active_reranker_key: key };
  }

  deleteReranker(key: string): { deleted_reranker_key: string } {
    if (!this.rerankers.delete(key)) {
      throw new VectorLibraryServiceError(`重排序器不存在: ${key}`, 404);
    }
    if (this.activeRerankerKey === key) {
      this.activeRerankerKey = this.rerankers.keys().next().value ?? null;
    }
    return { deleted_reranker_key: key };
  }

  vectorHealth(): Record<string, unknown> {
    return {
      status: "unavailable",
      runtime: "not_migrated",
      collections_count: 0,
      vectorizers_count: this.vectorizers.size,
      rerankers_count: this.rerankers.size,
      active_vectorizer_key: this.activeVectorizerKey,
      active_reranker_key: this.activeRerankerKey,
    };
  }

  listCollections(): Array<Record<string, unknown>> {
    return [];
  }

  listDocuments(collectionName: string): Record<string, unknown> {
    return {
      collection_name: collectionName,
      total_chunks: 0,
      sample_ids: [],
      info: {
        runtime: "not_migrated",
      },
    };
  }

  private listFileStatusVectorizers(): FileStatusVectorizer[] {
    return this.listVectorizers().map((vectorizer) => ({
      vectorizer_key: vectorizer.vectorizer_key,
      model_name: vectorizer.model_name,
      provider_key: vectorizer.provider_key,
      dimension: vectorizer.vector_dimension ?? 0,
      model_id: vectorizer.model_id,
    }));
  }

  private toVectorizerConfig(vectorizer: StoredVectorizer, fallbackModelId: number): VectorizerConfig {
    return {
      vectorizer_key: vectorizer.vectorizer_key,
      provider_key: vectorizer.provider_key,
      provider_type: vectorizer.provider_type,
      model_name: vectorizer.model_name,
      distance_metric: vectorizer.distance_metric,
      created_at: vectorizer.created_at,
      is_active: vectorizer.vectorizer_key === this.activeVectorizerKey,
      provider_available: this.modelAdapter.hasProvider(vectorizer.provider_key),
      vector_dimension: vectorizer.vector_dimension,
      vector_count: vectorizer.vector_count,
      model_id: vectorizer.model_id ?? fallbackModelId,
    };
  }

  private toRerankerConfig(reranker: StoredReranker): RerankerConfig {
    const config: RerankerConfig = {
      reranker_key: reranker.reranker_key,
      mode: reranker.mode,
      provider_key: reranker.provider_key,
      provider_type: reranker.provider_type,
      model_name: reranker.model_name,
      api_endpoint: reranker.api_endpoint,
      created_at: reranker.created_at,
      is_active: reranker.reranker_key === this.activeRerankerKey,
    };
    if (reranker.api_key !== undefined) {
      config.api_key = reranker.api_key;
    }
    return config;
  }
}

interface StoredVectorizer {
  vectorizer_key: string;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  distance_metric: string;
  created_at: string;
  vector_dimension: number | null;
  vector_count: number;
  model_id: number | null;
}

interface StoredReranker {
  reranker_key: string;
  mode: "model" | "lexical" | "none";
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  api_endpoint: string;
  created_at: string;
  api_key?: string | undefined;
}

function normalizeVectorizerKey(providerKey: string, modelName: string): string {
  return `${providerKey}_${safeKeyPart(modelName)}`;
}

function normalizeRerankerKey(mode: "model" | "lexical" | "none", providerKey: string, modelName: string): string {
  if (mode === "none") {
    return "noop";
  }
  if (mode === "lexical") {
    return "bm25_local";
  }
  return `${providerKey}_${safeKeyPart(modelName)}`;
}

function safeKeyPart(value: string): string {
  return value.replace(/[^\w.-]/g, "_").slice(0, 120);
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeRerankerMode(value: string | undefined): "model" | "lexical" | "none" {
  const mode = String(value ?? "none")
    .trim()
    .toLowerCase();
  if (["lexical", "bm25", "keyword", "local"].includes(mode)) {
    return "lexical";
  }
  if (["none", "noop"].includes(mode)) {
    return "none";
  }
  return "model";
}
