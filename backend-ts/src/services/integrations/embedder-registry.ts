/**
 * Embedder 注册表 + 工厂(可插拔 embedding 后端)——仿 Python `_PROVIDER_CLASSES`(dict + 工厂),避开 if/else。
 *
 * 深合约:
 * - createEmbedder 按 provider.provider_type 查 EMBEDDER_REGISTRY;命中 → 对应 factory 创建;
 *   未命中 / 无 provider → HashFallbackEmbedder(semantic:false,降级);
 * - RemoteEmbedder 走 OpenAI 兼容 /embeddings,dimension 惰性缓存(首次 embed 后有效,此前为 0);
 * - HashFallbackEmbedder 固定 64 维 hash(复制自 knowledge-base-service.ts:1423-1564),semantic:false;
 *   Batch 5 编排层切换后,旧 embedText 废弃,本实现成为唯一 hash 来源。
 */
import type { IEmbedder } from "../../contracts/vector-store/index.js";
import type { ModelProviderConfig } from "../../contracts/integrations/model-adapter.js";
import { OpenAiCompatibleEmbeddingClient, type EmbeddingClient } from "./embedding-client.js";

export interface EmbedderFactory {
  create(provider: ModelProviderConfig, modelName: string): IEmbedder;
}

export const EMBEDDER_REGISTRY: Map<string, EmbedderFactory> = new Map();

export function registerEmbedder(providerType: string, factory: EmbedderFactory): void {
  EMBEDDER_REGISTRY.set(providerType, factory);
}

/** OpenAI 兼容 embedding provider_type(POST /embeddings)。 */
const OPENAI_COMPATIBLE_EMBEDDER_TYPES = [
  "openai_chat",
  "openai_proxy",
  "deepseek",
  "openrouter",
  "modelscope",
  "openai_resp",
];

for (const providerType of OPENAI_COMPATIBLE_EMBEDDER_TYPES) {
  registerEmbedder(providerType, {
    create: (provider, modelName) => new RemoteEmbedder(provider, modelName),
  });
}

/**
 * 按 provider 配置创建 embedder。无 provider / 未知 provider_type → HashFallbackEmbedder(降级)。
 * 加新 embedder 类型 = registerEmbedder,不改分发逻辑(开闭原则)。
 */
export function createEmbedder(provider: ModelProviderConfig | null | undefined, modelName: string): IEmbedder {
  if (provider) {
    const factory = EMBEDDER_REGISTRY.get(provider.provider_type);
    if (factory) {
      return factory.create(provider, modelName);
    }
  }
  return new HashFallbackEmbedder();
}

/** 远程 embedding(OpenAI 兼容 /embeddings)。dimension 惰性:首次 embed 后缓存,此前为 0(未探测)。 */
export class RemoteEmbedder implements IEmbedder {
  private readonly client: EmbeddingClient;
  private cachedDimension = 0;
  readonly key: string;
  readonly semantic = true;

  constructor(
    private readonly provider: ModelProviderConfig,
    private readonly modelName: string,
    client?: EmbeddingClient,
  ) {
    this.client = client ?? new OpenAiCompatibleEmbeddingClient();
    this.key = `remote:${provider.key ?? provider.name}/${modelName}`;
  }

  get dimension(): number {
    return this.cachedDimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const vectors = await this.client.embed({ texts, model: this.modelName, provider: this.provider });
    if (this.cachedDimension === 0 && vectors.length > 0) {
      this.cachedDimension = vectors[0]?.length ?? 0;
    }
    return vectors;
  }
}

const HASH_EMBEDDING_DIMENSION = 64;

/** 本地 hash embedding 降级(无真 provider 时)。semantic:false,语义无意义,仅供开发/降级。 */
export class HashFallbackEmbedder implements IEmbedder {
  readonly key = "local:hash-64";
  readonly semantic = false;

  get dimension(): number {
    return HASH_EMBEDDING_DIMENSION;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashEmbed(text));
  }
}

// —— 本地 hash embedding 实现(复制自 knowledge-base-service.ts:1423-1564,Batch 5 切换后该处废弃)。
function hashEmbed(text: string): number[] {
  const vector = Array.from({ length: HASH_EMBEDDING_DIMENSION }, () => 0);
  for (const token of tokenize(text)) {
    const index = positiveHash(token) % HASH_EMBEDDING_DIMENSION;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return words.flatMap((word) => {
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 1) {
      const grams: string[] = [word];
      for (let index = 0; index < word.length - 1; index += 1) {
        grams.push(word.slice(index, index + 2));
      }
      return grams;
    }
    return [word];
  });
}

function positiveHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
