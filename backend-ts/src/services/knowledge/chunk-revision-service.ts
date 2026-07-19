import { KnowledgeBaseError } from "../../contracts/knowledge/knowledge-base.js";
import type { IVectorStore, StoredChunk, StoredVectorizer, VectorRecord } from "../../contracts/vector-store/index.js";

export class ChunkRevisionService {
  constructor(private readonly vectorStore: IVectorStore, private readonly resolveVectorizers: (chunk: StoredChunk) => Promise<StoredVectorizer[]>, private readonly embed: (vectorizer: StoredVectorizer, texts: string[]) => Promise<number[][]>) {}

  async updateContent(fileId: string, chunkId: number, content: string): Promise<StoredChunk> {
    const chunk = (await this.vectorStore.listChunks()).find((item) => item.id === chunkId && item.document_id === fileId);
    if (!chunk) throw new KnowledgeBaseError(`切片不存在: ${chunkId}`, 404);
    const metadata = { ...chunk.metadata, manual: true };
    const vectorizers = await this.resolveVectorizers(chunk);
    if (!vectorizers.length) throw new KnowledgeBaseError("切片没有可用的向量模型，无法重嵌入", 409);
    for (const vectorizer of vectorizers) {
      const [embedding] = await this.embed(vectorizer, [content]);
      const record: VectorRecord = { id: String(chunk.id), doc_id: chunk.document_id, collection: chunk.collection, model_id: vectorizer.model_id, chunk_index: chunk.chunk_index, content, metadata, embedding: embedding ?? [] };
      await this.vectorStore.upsertRecords([record]);
    }
    return { ...chunk, content, metadata };
  }
}
