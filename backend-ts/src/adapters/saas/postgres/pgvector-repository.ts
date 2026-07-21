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
import type { PostgresMemoryExecutor } from "./memory-repository.js";

const vectorParam = (vector: number[]) => `[${vector.join(",")}]`;
const logicalChunkId = (alias = "") => {
  const prefix = alias ? `${alias}.` : "";
  return `md5(${prefix}tenant_id || chr(31) || ${prefix}collection || chr(31) || ${prefix}document_id || chr(31) || ${prefix}chunk_index::text)::uuid`;
};

const metadataFrom = (value: unknown): Record<string, unknown> => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid legacy metadata is projected as an empty object.
    }
  }
  return {};
};

const chunkFrom = (row: Record<string, unknown>): AsyncKnowledgeChunk => ({
  id: String(row.id),
  tenant_id: String(row.tenant_id),
  collection: String(row.collection),
  document_id: String(row.document_id),
  model_id: Number(row.model_id),
  chunk_index: Number(row.chunk_index),
  content: String(row.content),
  metadata: metadataFrom(row.metadata),
});

export class PostgresPgVectorRepository implements AsyncKnowledgeVectorStore {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async upsertChunks(records: AsyncVectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.executor.transaction((tx) => this.upsertChunksWith(tx, records));
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
    await this.executor.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM knowledge_vector_chunks WHERE tenant_id=$1 AND collection=$2 AND document_id=$3 AND model_id=$4",
        [input.tenant_id, input.collection, input.document_id, input.model_id],
      );
      await this.upsertChunksWith(tx, input.records);
    });
  }

  private async upsertChunksWith(executor: PostgresMemoryExecutor, records: AsyncVectorRecord[]): Promise<void> {
    for (const record of records) {
      if (!record.embedding.length) throw new Error("pgvector embedding must not be empty");
      await executor.query(
        `INSERT INTO knowledge_vector_chunks(
          tenant_id,collection,document_id,model_id,chunk_index,content,metadata,embedding,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::vector,CURRENT_TIMESTAMP)
        ON CONFLICT (tenant_id,collection,document_id,model_id,chunk_index) DO UPDATE SET
          content=EXCLUDED.content,metadata=EXCLUDED.metadata,embedding=EXCLUDED.embedding,updated_at=CURRENT_TIMESTAMP`,
        [
          record.tenant_id,
          record.collection,
          record.document_id,
          record.model_id,
          record.chunk_index,
          record.content,
          JSON.stringify(record.metadata ?? {}),
          vectorParam(record.embedding),
        ],
      );
    }
  }

  async search(input: AsyncVectorSearchInput): Promise<AsyncVectorSearchHit[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(input.top_k)));
    const result = await this.executor.query(
      `SELECT id,tenant_id,collection,document_id,model_id,chunk_index,content,metadata,
        1 - (embedding <=> $5::vector) AS vector_score
       FROM knowledge_vector_chunks
       WHERE tenant_id=$1 AND collection=$2 AND model_id=$3
       ORDER BY embedding <=> $5::vector LIMIT $4`,
      [input.tenant_id, input.collection, input.model_id, limit, vectorParam(input.query_vector)],
    );
    return result.rows.map((row) => ({
      ...chunkFrom(row),
      vector_score: Number(row.vector_score),
    }));
  }

  async listCollections(tenantId: string): Promise<AsyncKnowledgeCollectionSummary[]> {
    const result = await this.executor.query(
      `SELECT collection AS name,
        COUNT(DISTINCT document_id)::int AS document_count,
        COUNT(DISTINCT (document_id,chunk_index))::int AS chunk_count,
        MAX(vector_dims(embedding))::int AS embedding_dimension
       FROM knowledge_vector_chunks WHERE tenant_id=$1
       GROUP BY collection ORDER BY collection`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      name: String(row.name),
      document_count: Number(row.document_count),
      chunk_count: Number(row.chunk_count),
      total_chunks: Number(row.chunk_count),
      embedding_dimension: row.embedding_dimension == null ? null : Number(row.embedding_dimension),
    }));
  }

  async listDocumentIndexes(tenantId: string): Promise<AsyncKnowledgeDocumentIndexSummary[]> {
    const result = await this.executor.query(
      `SELECT collection,document_id,model_id,COUNT(*)::int AS chunk_count
       FROM knowledge_vector_chunks WHERE tenant_id=$1
       GROUP BY collection,document_id,model_id ORDER BY collection,document_id,model_id`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      collection: String(row.collection),
      document_id: String(row.document_id),
      model_id: Number(row.model_id),
      chunk_count: Number(row.chunk_count),
    }));
  }

  async listChunks(input: {
    tenant_id: string;
    collection?: string;
    document_id?: string;
    model_id?: number;
  }): Promise<AsyncKnowledgeChunk[]> {
    const { clauses, params } = buildScope(input);
    const select = input.model_id === undefined
      ? "SELECT DISTINCT ON (collection,document_id,chunk_index)"
      : "SELECT";
    const orderBy = input.model_id === undefined
      ? "collection,document_id,chunk_index,model_id"
      : "collection,document_id,model_id,chunk_index";
    const result = await this.executor.query(
      `${select} ${logicalChunkId()} AS id,tenant_id,collection,document_id,model_id,chunk_index,content,metadata
       FROM knowledge_vector_chunks WHERE ${clauses.join(" AND ")}
       ORDER BY ${orderBy}`,
      params,
    );
    return result.rows.map(chunkFrom);
  }

  async getChunk(tenantId: string, chunkId: string): Promise<AsyncKnowledgeChunk | null> {
    if (!isUuid(chunkId)) return null;
    const result = await this.executor.query(
      `SELECT ${logicalChunkId()} AS id,tenant_id,collection,document_id,model_id,chunk_index,content,metadata
       FROM knowledge_vector_chunks WHERE tenant_id=$1 AND ${logicalChunkId()}=$2::uuid
       ORDER BY model_id LIMIT 1`,
      [tenantId, chunkId],
    );
    return result.rows[0] ? chunkFrom(result.rows[0]) : null;
  }

  async listChunkVersions(tenantId: string, chunkId: string): Promise<AsyncKnowledgeChunk[]> {
    if (!isUuid(chunkId)) return [];
    const result = await this.executor.query(
      `WITH target AS (
         SELECT DISTINCT collection,document_id,chunk_index FROM knowledge_vector_chunks
         WHERE tenant_id=$1 AND ${logicalChunkId()}=$2::uuid
       )
       SELECT ${logicalChunkId("chunk")} AS id,chunk.tenant_id,chunk.collection,chunk.document_id,chunk.model_id,
         chunk.chunk_index,chunk.content,chunk.metadata
       FROM knowledge_vector_chunks chunk
       JOIN target ON target.collection=chunk.collection
         AND target.document_id=chunk.document_id AND target.chunk_index=chunk.chunk_index
       WHERE chunk.tenant_id=$1 ORDER BY chunk.model_id`,
      [tenantId, chunkId],
    );
    return result.rows.map(chunkFrom);
  }

  async listDocuments(input: { tenant_id: string; collection: string }): Promise<AsyncKnowledgeDocumentSummary[]> {
    return this.queryDocuments("tenant_id=$1 AND collection=$2", [input.tenant_id, input.collection]);
  }

  async listAllDocuments(tenantId: string): Promise<AsyncKnowledgeDocumentSummary[]> {
    return this.queryDocuments("tenant_id=$1", [tenantId]);
  }

  async countVectors(input: { tenant_id: string; collection: string; model_id: number }): Promise<number> {
    return this.queryCount("tenant_id=$1 AND collection=$2 AND model_id=$3", [input.tenant_id, input.collection, input.model_id]);
  }

  async countVectorsByModel(input: { tenant_id: string; model_id: number }): Promise<Array<{ collection: string; count: number }>> {
    const result = await this.executor.query(
      `SELECT collection,COUNT(*)::int AS count FROM knowledge_vector_chunks
       WHERE tenant_id=$1 AND model_id=$2 GROUP BY collection ORDER BY collection`,
      [input.tenant_id, input.model_id],
    );
    return result.rows.map((row) => ({ collection: String(row.collection), count: Number(row.count) }));
  }

  async countVectorsForDocument(input: {
    tenant_id: string;
    collection: string;
    document_id: string;
    model_id: number;
  }): Promise<number> {
    return this.queryCount(
      "tenant_id=$1 AND collection=$2 AND document_id=$3 AND model_id=$4",
      [input.tenant_id, input.collection, input.document_id, input.model_id],
    );
  }

  async countChunks(input: { tenant_id: string; collection: string }): Promise<number> {
    const result = await this.executor.query(
      `SELECT COUNT(DISTINCT (document_id,chunk_index))::int AS count
       FROM knowledge_vector_chunks WHERE tenant_id=$1 AND collection=$2`,
      [input.tenant_id, input.collection],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getDimension(input: { tenant_id: string; model_id: number }): Promise<number | null> {
    const result = await this.executor.query(
      `SELECT vector_dims(embedding)::int AS dimension FROM knowledge_vector_chunks
       WHERE tenant_id=$1 AND model_id=$2 LIMIT 1`,
      [input.tenant_id, input.model_id],
    );
    return result.rows[0]?.dimension == null ? null : Number(result.rows[0].dimension);
  }

  async health(tenantId: string): Promise<{ status: string; runtime: string; ann: boolean; collections_count: number }> {
    const result = await this.executor.query(
      "SELECT COUNT(DISTINCT collection)::int AS count FROM knowledge_vector_chunks WHERE tenant_id=$1",
      [tenantId],
    );
    return { status: "healthy", runtime: "pgvector", ann: true, collections_count: Number(result.rows[0]?.count ?? 0) };
  }

  async deleteChunks(input: { tenant_id: string; collection?: string; document_id?: string; model_id?: number }): Promise<number> {
    const { clauses, params } = buildScope(input);
    const result = await this.executor.query(
      `WITH deleted AS (
        DELETE FROM knowledge_vector_chunks WHERE ${clauses.join(" AND ")}
        RETURNING document_id,chunk_index
      ) SELECT COUNT(DISTINCT (document_id,chunk_index))::int AS count FROM deleted`,
      params,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  deleteCollection(input: { tenant_id: string; collection: string }): Promise<number> {
    return this.deleteChunks(input);
  }

  private async queryDocuments(where: string, params: readonly unknown[]): Promise<AsyncKnowledgeDocumentSummary[]> {
    const result = await this.executor.query(
      `SELECT collection,document_id,COUNT(DISTINCT chunk_index)::int AS chunk_count,
        jsonb_agg(metadata ORDER BY model_id,chunk_index)->0 AS metadata
       FROM knowledge_vector_chunks WHERE ${where}
       GROUP BY collection,document_id ORDER BY collection,document_id`,
      params,
    );
    return result.rows.map((row) => ({
      collection: String(row.collection),
      document_id: String(row.document_id),
      chunk_count: Number(row.chunk_count),
      metadata: row.metadata == null ? null : metadataFrom(row.metadata),
    }));
  }

  private async queryCount(where: string, params: readonly unknown[]): Promise<number> {
    const result = await this.executor.query(`SELECT COUNT(*)::int AS count FROM knowledge_vector_chunks WHERE ${where}`, params);
    return Number(result.rows[0]?.count ?? 0);
  }
}

function buildScope(input: { tenant_id: string; collection?: string; document_id?: string; model_id?: number }): {
  clauses: string[];
  params: unknown[];
} {
  const clauses = ["tenant_id=$1"];
  const params: unknown[] = [input.tenant_id];
  if (input.collection !== undefined) {
    params.push(input.collection);
    clauses.push(`collection=$${params.length}`);
  }
  if (input.document_id !== undefined) {
    params.push(input.document_id);
    clauses.push(`document_id=$${params.length}`);
  }
  if (input.model_id !== undefined) {
    params.push(input.model_id);
    clauses.push(`model_id=$${params.length}`);
  }
  return { clauses, params };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
