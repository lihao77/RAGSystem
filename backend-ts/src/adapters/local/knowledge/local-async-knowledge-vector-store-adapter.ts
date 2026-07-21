import type {
  AsyncKnowledgeChunk,
  AsyncKnowledgeCollectionSummary,
  AsyncKnowledgeDocumentIndexSummary,
  AsyncKnowledgeDocumentSummary,
  AsyncKnowledgeVectorStore,
  AsyncVectorRecord,
  AsyncVectorSearchHit,
  AsyncVectorSearchInput,
} from "../../../contracts/knowledge/async-vector-store.js";
import type {
  DocumentInfo,
  IKnowledgeConfig,
  IVectorStore,
  StoredChunk,
  VectorSearchHit,
} from "../../../contracts/vector-store/index.js";

/** Promise-based, tenant-bound view over the Local SQLite vector driver. */
export class LocalAsyncKnowledgeVectorStoreAdapter implements AsyncKnowledgeVectorStore {
  constructor(
    private readonly vectors: IVectorStore,
    private readonly config: IKnowledgeConfig,
  ) {}

  async upsertChunks(records: AsyncVectorRecord[]): Promise<void> {
    await this.vectors.upsertRecords(records.map(mapVectorRecord));
  }

  async replaceChunks(input: {
    tenant_id: string;
    collection: string;
    document_id: string;
    model_id: number;
    records: AsyncVectorRecord[];
  }): Promise<void> {
    if (input.records.some((record) =>
      record.tenant_id !== input.tenant_id
      || record.collection !== input.collection
      || record.document_id !== input.document_id
      || record.model_id !== input.model_id
    )) {
      throw new Error("replacement chunks must match their tenant, collection, document, and model scope");
    }
    await this.vectors.replaceDocumentVectorsByModel(
      input.collection,
      input.document_id,
      input.model_id,
      input.records.map(mapVectorRecord),
    );
  }

  async search(input: AsyncVectorSearchInput): Promise<AsyncVectorSearchHit[]> {
    const [hits, chunks] = await Promise.all([
      this.vectors.search({
        collection: input.collection,
        model_id: input.model_id,
        query_vector: input.query_vector,
        top_k: input.top_k,
        search_mode: "vector",
      }),
      this.vectors.listChunks(input.collection),
    ]);
    const chunksById = new Map(chunks.map((chunk) => [String(chunk.id), chunk]));
    return hits.map((hit) => this.mapSearchHit(hit, input, chunksById.get(hit.id)));
  }

  async listCollections(_tenantId: string): Promise<AsyncKnowledgeCollectionSummary[]> {
    return (await this.vectors.listCollections()).map((collection) => ({
      name: collection.name,
      document_count: collection.document_count,
      chunk_count: collection.total_chunks,
      total_chunks: collection.total_chunks,
      embedding_dimension: collection.embedding_dimension,
    }));
  }

  async listDocumentIndexes(_tenantId: string): Promise<AsyncKnowledgeDocumentIndexSummary[]> {
    const [documents, vectorizers] = await Promise.all([
      this.vectors.listAllDocuments(),
      Promise.resolve(this.config.listVectorizers()),
    ]);
    const indexes = await Promise.all(documents.flatMap((document) => vectorizers.map(async (vectorizer) => ({
      collection: document.collection,
      document_id: document.document_id,
      model_id: vectorizer.model_id,
      chunk_count: await this.vectors.countVectorsForDocument(
        document.collection,
        document.document_id,
        vectorizer.model_id,
      ),
    }))));
    return indexes.filter((index) => index.chunk_count > 0);
  }

  async listChunks(input: {
    tenant_id: string;
    collection?: string;
    document_id?: string;
    model_id?: number;
  }): Promise<AsyncKnowledgeChunk[]> {
    let chunks = await this.vectors.listChunks(input.collection);
    if (input.document_id !== undefined) {
      chunks = chunks.filter((chunk) => chunk.document_id === input.document_id);
    }

    if (input.model_id !== undefined) {
      const indexedDocuments = await this.indexedDocumentKeys(chunks, input.model_id);
      return chunks
        .filter((chunk) => indexedDocuments.has(documentKey(chunk)))
        .map((chunk) => this.mapChunk(chunk, input.tenant_id, input.model_id!));
    }

    const projectedModels = await this.projectedModelsByDocument(chunks);
    return chunks.map((chunk) => this.mapChunk(
      chunk,
      input.tenant_id,
      projectedModels.get(documentKey(chunk)) ?? 0,
    ));
  }

  async getChunk(tenantId: string, chunkId: string): Promise<AsyncKnowledgeChunk | null> {
    const chunks = await this.vectors.listChunks();
    const chunk = chunks.find((candidate) => String(candidate.id) === chunkId);
    if (!chunk) return null;
    const [modelId] = await this.modelIdsForDocument(chunk.collection, chunk.document_id);
    return this.mapChunk(chunk, tenantId, modelId ?? 0);
  }

  async listChunkVersions(tenantId: string, chunkId: string): Promise<AsyncKnowledgeChunk[]> {
    const chunks = await this.vectors.listChunks();
    const target = chunks.find((candidate) => String(candidate.id) === chunkId);
    if (!target) return [];

    const logicalChunk = chunks.find((candidate) =>
      candidate.collection === target.collection
      && candidate.document_id === target.document_id
      && candidate.chunk_index === target.chunk_index
    );
    if (!logicalChunk) return [];
    const modelIds = await this.modelIdsForDocument(logicalChunk.collection, logicalChunk.document_id);
    return modelIds.map((modelId) => this.mapChunk(logicalChunk, tenantId, modelId));
  }

  async listDocuments(input: { tenant_id: string; collection: string }): Promise<AsyncKnowledgeDocumentSummary[]> {
    return (await this.vectors.listDocuments(input.collection)).map(mapDocument);
  }

  async listAllDocuments(_tenantId: string): Promise<AsyncKnowledgeDocumentSummary[]> {
    return (await this.vectors.listAllDocuments()).map(mapDocument);
  }

  async countVectors(input: { tenant_id: string; collection: string; model_id: number }): Promise<number> {
    return this.vectors.countVectors(input.collection, input.model_id);
  }

  async countVectorsByModel(input: { tenant_id: string; model_id: number }): Promise<Array<{ collection: string; count: number }>> {
    return this.vectors.countVectorsByModel(input.model_id);
  }

  async countVectorsForDocument(input: {
    tenant_id: string;
    collection: string;
    document_id: string;
    model_id: number;
  }): Promise<number> {
    return this.vectors.countVectorsForDocument(input.collection, input.document_id, input.model_id);
  }

  async countChunks(input: { tenant_id: string; collection: string }): Promise<number> {
    return this.vectors.countChunks(input.collection);
  }

  async getDimension(input: { tenant_id: string; model_id: number }): Promise<number | null> {
    return this.vectors.getDimension(input.model_id);
  }

  async health(_tenantId: string): Promise<{ status: string; runtime: string; ann: boolean; collections_count: number }> {
    return this.vectors.health();
  }

  async deleteChunks(input: {
    tenant_id: string;
    collection?: string;
    document_id?: string;
    model_id?: number;
  }): Promise<number> {
    if (input.model_id !== undefined) {
      if (input.document_id !== undefined) {
        const collections = input.collection === undefined
          ? unique((await this.vectors.listAllDocuments())
            .filter((document) => document.document_id === input.document_id)
            .map((document) => document.collection))
          : [input.collection];
        const deleted = await Promise.all(collections.map((collection) =>
          this.vectors.deleteDocumentVectorsByModel(collection, input.document_id!, input.model_id!)
        ));
        return deleted.reduce((sum, result) => sum + result.deleted, 0);
      }
      if (input.collection !== undefined) {
        const documents = await this.vectors.listDocuments(input.collection);
        const deleted = await Promise.all(documents.map((document) =>
          this.vectors.deleteDocumentVectorsByModel(input.collection!, document.document_id, input.model_id!)
        ));
        return deleted.reduce((sum, result) => sum + result.deleted, 0);
      }
      return (await this.vectors.deleteByModel(input.model_id)).deleted;
    }

    if (input.document_id !== undefined) {
      return input.collection === undefined
        ? (await this.vectors.deleteDocumentVectors(input.document_id)).deleted_chunks
        : (await this.vectors.deleteDocument(input.collection, input.document_id)).deleted_chunks;
    }
    if (input.collection !== undefined) {
      return (await this.vectors.deleteCollection(input.collection)).deleted_chunks;
    }

    const deleted = await Promise.all((await this.vectors.listCollections()).map((collection) =>
      this.vectors.deleteCollection(collection.name)
    ));
    return deleted.reduce((sum, result) => sum + result.deleted_chunks, 0);
  }

  async deleteCollection(input: { tenant_id: string; collection: string }): Promise<number> {
    return (await this.vectors.deleteCollection(input.collection)).deleted_chunks;
  }

  private async indexedDocumentKeys(chunks: StoredChunk[], modelId: number): Promise<Set<string>> {
    const documents = uniqueDocuments(chunks);
    const counts = await Promise.all(documents.map((document) =>
      this.vectors.countVectorsForDocument(document.collection, document.document_id, modelId)
    ));
    return new Set(documents.filter((_document, index) => (counts[index] ?? 0) > 0).map(documentKey));
  }

  private async projectedModelsByDocument(chunks: StoredChunk[]): Promise<Map<string, number>> {
    const documents = uniqueDocuments(chunks);
    const models = await Promise.all(documents.map(async (document) => {
      const [modelId] = await this.modelIdsForDocument(document.collection, document.document_id);
      return modelId;
    }));
    return new Map(documents.flatMap((document, index) => {
      const modelId = models[index];
      return modelId === undefined ? [] : [[documentKey(document), modelId]];
    }));
  }

  private async modelIdsForDocument(collection: string, documentId: string): Promise<number[]> {
    const vectorizers = this.config.listVectorizers();
    const counts = await Promise.all(vectorizers.map((vectorizer) =>
      this.vectors.countVectorsForDocument(collection, documentId, vectorizer.model_id)
    ));
    return vectorizers
      .filter((_vectorizer, index) => (counts[index] ?? 0) > 0)
      .map((vectorizer) => vectorizer.model_id);
  }

  private mapChunk(chunk: StoredChunk, tenantId: string, modelId: number): AsyncKnowledgeChunk {
    return {
      id: String(chunk.id),
      tenant_id: tenantId,
      collection: chunk.collection,
      document_id: chunk.document_id,
      model_id: modelId,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      metadata: chunk.metadata,
    };
  }

  private mapSearchHit(
    hit: VectorSearchHit,
    input: AsyncVectorSearchInput,
    chunk: StoredChunk | undefined,
  ): AsyncVectorSearchHit {
    const metadataChunkIndex = hit.metadata.chunk_index;
    return {
      id: hit.id,
      tenant_id: input.tenant_id,
      collection: hit.collection,
      document_id: hit.document_id,
      model_id: input.model_id,
      chunk_index: chunk?.chunk_index
        ?? (typeof metadataChunkIndex === "number" && Number.isSafeInteger(metadataChunkIndex) ? metadataChunkIndex : 0),
      content: hit.content,
      metadata: hit.metadata,
      vector_score: hit.vector_score,
    };
  }
}

function mapDocument(document: DocumentInfo): AsyncKnowledgeDocumentSummary {
  return {
    collection: document.collection,
    document_id: document.document_id,
    chunk_count: document.chunk_count,
    metadata: document.metadata,
  };
}

function documentKey(document: Pick<StoredChunk | DocumentInfo, "collection" | "document_id">): string {
  return `${document.collection}\u0000${document.document_id}`;
}

function uniqueDocuments(chunks: StoredChunk[]): Array<Pick<StoredChunk, "collection" | "document_id">> {
  const documents = new Map<string, Pick<StoredChunk, "collection" | "document_id">>();
  for (const chunk of chunks) documents.set(documentKey(chunk), chunk);
  return [...documents.values()];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mapVectorRecord(record: AsyncVectorRecord) {
  return {
    id: record.id ?? "",
    doc_id: record.document_id,
    collection: record.collection,
    model_id: record.model_id,
    chunk_index: record.chunk_index,
    content: record.content,
    metadata: record.metadata,
    embedding: record.embedding,
  };
}
