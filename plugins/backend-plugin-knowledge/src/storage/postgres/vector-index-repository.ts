import type { AsyncKnowledgeVectorIndex, KnowledgeVectorIndexRecord, UpsertKnowledgeVectorIndexInput } from "../../contracts/knowledge/async-vector-index.js";
import type { KnowledgePostgresQueryExecutor } from "./executor.js";

function map(row: Record<string, unknown>): KnowledgeVectorIndexRecord {
  return {
    tenant_id: String(row.tenant_id), collection: String(row.collection), document_id: String(row.document_id),
    model_id: Number(row.model_id), chunk_count: Number(row.chunk_count),
    embedding_dimension: row.embedding_dimension == null ? null : Number(row.embedding_dimension),
    status: row.status as KnowledgeVectorIndexRecord["status"], error_message: row.error_message == null ? null : String(row.error_message),
    indexed_at: row.indexed_at == null ? null : new Date(String(row.indexed_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

export class PostgresKnowledgeVectorIndexRepository implements AsyncKnowledgeVectorIndex {
  constructor(private readonly executor: KnowledgePostgresQueryExecutor) {}

  async upsert(input: UpsertKnowledgeVectorIndexInput): Promise<KnowledgeVectorIndexRecord> {
    const status = input.status ?? "pending";
    const result = await this.executor.query(
      `INSERT INTO knowledge_vector_index(tenant_id,collection,document_id,model_id,chunk_count,embedding_dimension,status,error_message,indexed_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7='indexed' THEN CURRENT_TIMESTAMP ELSE NULL END,CURRENT_TIMESTAMP)
       ON CONFLICT (tenant_id,collection,document_id,model_id) DO UPDATE SET chunk_count=EXCLUDED.chunk_count,embedding_dimension=EXCLUDED.embedding_dimension,status=EXCLUDED.status,error_message=EXCLUDED.error_message,indexed_at=CASE WHEN EXCLUDED.status='indexed' THEN CURRENT_TIMESTAMP ELSE knowledge_vector_index.indexed_at END,updated_at=CURRENT_TIMESTAMP
       RETURNING *`,
      [input.tenant_id, input.collection, input.document_id, input.model_id, input.chunk_count, input.embedding_dimension ?? null, status, input.error_message ?? null],
    );
    if (!result.rows[0]) throw new Error("knowledge vector index upsert returned no row");
    return map(result.rows[0]);
  }

  async get(tenantId: string, collection: string, documentId: string, modelId: number): Promise<KnowledgeVectorIndexRecord | null> {
    const result = await this.executor.query("SELECT * FROM knowledge_vector_index WHERE tenant_id=$1 AND collection=$2 AND document_id=$3 AND model_id=$4", [tenantId, collection, documentId, modelId]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async listForDocument(tenantId: string, documentId: string): Promise<KnowledgeVectorIndexRecord[]> {
    const result = await this.executor.query("SELECT * FROM knowledge_vector_index WHERE tenant_id=$1 AND document_id=$2 ORDER BY collection,model_id", [tenantId, documentId]);
    return result.rows.map(map);
  }

  async deleteForDocument(tenantId: string, documentId: string): Promise<number> {
    const result = await this.executor.query("DELETE FROM knowledge_vector_index WHERE tenant_id=$1 AND document_id=$2", [tenantId, documentId]);
    return Number(result.rowCount ?? 0);
  }

  async deleteForModel(tenantId: string, modelId: number): Promise<number> {
    const result = await this.executor.query("DELETE FROM knowledge_vector_index WHERE tenant_id=$1 AND model_id=$2", [tenantId, modelId]);
    return Number(result.rowCount ?? 0);
  }
}
