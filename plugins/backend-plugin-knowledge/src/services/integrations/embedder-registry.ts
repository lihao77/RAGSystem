/**
 * Embedder 工厂（可插拔 embedding 后端）。
 *
 * 深合约：
 * - 有 provider（知识库自管的 embedding 模型服务，OpenAI 兼容 /embeddings）→ RemoteEmbedder；
 *   无 provider（"local" 向量化器）→ HashFallbackEmbedder(semantic:false, 降级)；
 * - RemoteEmbedder dimension 惰性缓存（首次 embed 后有效，此前为 0）；
 * - HashFallbackEmbedder 固定 64 维 hash，semantic:false，仅供开发/降级。
 */
import type { IEmbedder } from "../../contracts/vector-store/index.js";
import type { EmbeddingClientPort, KnowledgeModelProvider } from "../../contracts/knowledge/model-providers.js";

export function createEmbedder(
  provider: KnowledgeModelProvider | null,
  modelName: string,
  client?: EmbeddingClientPort,
): IEmbedder {
  return provider ? new RemoteEmbedder(provider, modelName, client) : new HashFallbackEmbedder();
}

/** 远程 embedding(OpenAI 兼容 /embeddings)。 */
export class RemoteEmbedder implements IEmbedder {
  private readonly client: EmbeddingClientPort;
  private cachedDimension = 0;
  readonly key: string;
  readonly semantic = true;

  constructor(
    private readonly provider: KnowledgeModelProvider,
    private readonly modelName: string,
    client?: EmbeddingClientPort,
  ) {
    if (!client) throw new Error("Knowledge embedding requires an embedding client");
    this.client = client;
    this.key = `remote:${provider.provider_key}/${modelName}`;
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

// —— 本地 hash embedding 实现。
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
