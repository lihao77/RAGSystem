import type { AsyncKnowledgeConfigStore } from "../../contracts/knowledge/async-knowledge-config.js";
import type { CreateRerankerInput, CreateVectorizerInput, StoredReranker, StoredVectorizer } from "../../contracts/vector-store/knowledge-config.js";
import type { KnowledgePostgresExecutor } from "./executor.js";

function map(row: Record<string, unknown>): StoredVectorizer {
  return {
    model_id: Number(row.model_id), vectorizer_key: String(row.vectorizer_key), provider_key: String(row.provider_key),
    provider_type: row.provider_type == null ? null : String(row.provider_type), model_name: String(row.model_name),
    distance_metric: String(row.distance_metric), created_at: new Date(String(row.created_at)).toISOString(),
    vector_dimension: row.vector_dimension == null ? null : Number(row.vector_dimension), is_active: Boolean(row.is_active),
  };
}

function mapReranker(row: Record<string, unknown>): StoredReranker {
  return {
    reranker_key: String(row.reranker_key), mode: row.mode as StoredReranker["mode"],
    provider_key: String(row.provider_key ?? ""), provider_type: row.provider_type == null ? null : String(row.provider_type),
    model_name: String(row.model_name ?? ""), api_endpoint: String(row.api_endpoint ?? ""),
    api_key: row.api_key == null ? null : String(row.api_key), created_at: new Date(String(row.created_at)).toISOString(),
    is_active: Boolean(row.is_active),
  };
}

export class PostgresKnowledgeConfigRepository implements AsyncKnowledgeConfigStore {
  constructor(private readonly executor: KnowledgePostgresExecutor) {}
  async listVectorizers(tenantId: string): Promise<StoredVectorizer[]> {
    const result = await this.executor.query("SELECT * FROM knowledge_vectorizers WHERE tenant_id=$1 ORDER BY model_id", [tenantId]);
    return result.rows.map(map);
  }
  async getVectorizerByKey(tenantId: string, key: string): Promise<StoredVectorizer | null> {
    const result = await this.executor.query("SELECT * FROM knowledge_vectorizers WHERE tenant_id=$1 AND vectorizer_key=$2", [tenantId, key]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async createVectorizer(tenantId: string, input: CreateVectorizerInput): Promise<StoredVectorizer> {
    return this.executor.transaction(async (tx) => {
      await lockVectorizerTenant(tx, tenantId);
      const result = await tx.query(
        `INSERT INTO knowledge_vectorizers(tenant_id,vectorizer_key,provider_key,provider_type,model_name,distance_metric,is_active)
         VALUES($1,$2,$3,$4,$5,$6,NOT EXISTS(SELECT 1 FROM knowledge_vectorizers WHERE tenant_id=$1)) RETURNING *`,
        [tenantId, input.vectorizer_key, input.provider_key, input.provider_type, input.model_name, input.distance_metric],
      );
      if (!result.rows[0]) throw new Error("knowledge vectorizer insert returned no row");
      return map(result.rows[0]);
    });
  }
  async setVectorDimension(tenantId: string, key: string, dimension: number): Promise<void> {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) throw new Error("vector dimension must be a positive integer");
    const result = await this.executor.query(
      "UPDATE knowledge_vectorizers SET vector_dimension=$3 WHERE tenant_id=$1 AND vectorizer_key=$2 AND (vector_dimension IS NULL OR vector_dimension=$3)",
      [tenantId, key, dimension],
    );
    if (!result.rowCount) throw new Error(`vectorizer dimension mismatch or vectorizer not found: ${key}`);
  }
  async activateVectorizer(tenantId: string, key: string): Promise<void> {
    await this.executor.transaction(async (tx) => {
      await lockVectorizerTenant(tx, tenantId);
      const found = await tx.query("SELECT model_id FROM knowledge_vectorizers WHERE tenant_id=$1 AND vectorizer_key=$2", [tenantId, key]);
      if (!found.rows[0]) throw new Error(`vectorizer not found: ${key}`);
      await tx.query("UPDATE knowledge_vectorizers SET is_active=FALSE WHERE tenant_id=$1", [tenantId]);
      await tx.query("UPDATE knowledge_vectorizers SET is_active=TRUE WHERE tenant_id=$1 AND vectorizer_key=$2", [tenantId, key]);
    });
  }
  async deleteVectorizer(tenantId: string, key: string): Promise<{ next_active_key: string | null }> {
    return this.executor.transaction(async (tx) => {
      await lockVectorizerTenant(tx, tenantId);
      const deleted = await tx.query<{ is_active: boolean }>("DELETE FROM knowledge_vectorizers WHERE tenant_id=$1 AND vectorizer_key=$2 RETURNING is_active", [tenantId, key]);
      if (!deleted.rows[0]) throw new Error(`vectorizer not found: ${key}`);
      if (deleted.rows[0].is_active) await tx.query("UPDATE knowledge_vectorizers SET is_active=TRUE WHERE model_id=(SELECT model_id FROM knowledge_vectorizers WHERE tenant_id=$1 ORDER BY model_id LIMIT 1)", [tenantId]);
      const active = await tx.query<{ vectorizer_key: string }>("SELECT vectorizer_key FROM knowledge_vectorizers WHERE tenant_id=$1 AND is_active", [tenantId]);
      return { next_active_key: active.rows[0]?.vectorizer_key ?? null };
    });
  }

  async listRerankers(tenantId: string): Promise<StoredReranker[]> {
    const result = await this.executor.query("SELECT * FROM knowledge_rerankers WHERE tenant_id=$1 ORDER BY created_at,reranker_key", [tenantId]);
    return result.rows.map(mapReranker);
  }
  async getReranker(tenantId: string, key: string): Promise<StoredReranker | null> {
    const result = await this.executor.query("SELECT * FROM knowledge_rerankers WHERE tenant_id=$1 AND reranker_key=$2", [tenantId, key]);
    return result.rows[0] ? mapReranker(result.rows[0]) : null;
  }
  async createReranker(tenantId: string, input: CreateRerankerInput): Promise<StoredReranker> {
    return this.executor.transaction(async (tx) => {
      await lockRerankerTenant(tx, tenantId);
      const result = await tx.query(
        "INSERT INTO knowledge_rerankers(tenant_id,reranker_key,mode,provider_key,provider_type,model_name,api_endpoint,api_key,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOT EXISTS(SELECT 1 FROM knowledge_rerankers WHERE tenant_id=$1)) RETURNING *",
        [tenantId, input.reranker_key, input.mode, input.provider_key, input.provider_type, input.model_name, input.api_endpoint, input.api_key],
      );
      if (!result.rows[0]) throw new Error("knowledge reranker insert returned no row");
      return mapReranker(result.rows[0]);
    });
  }
  async activateReranker(tenantId: string, key: string): Promise<void> {
    await this.executor.transaction(async (tx) => {
      await lockRerankerTenant(tx, tenantId);
      const found = await tx.query("SELECT reranker_key FROM knowledge_rerankers WHERE tenant_id=$1 AND reranker_key=$2", [tenantId, key]);
      if (!found.rows[0]) throw new Error(`reranker not found: ${key}`);
      await tx.query("UPDATE knowledge_rerankers SET is_active=FALSE WHERE tenant_id=$1", [tenantId]);
      await tx.query("UPDATE knowledge_rerankers SET is_active=TRUE WHERE tenant_id=$1 AND reranker_key=$2", [tenantId, key]);
    });
  }
  async deleteReranker(tenantId: string, key: string): Promise<{ next_active_key: string | null }> {
    return this.executor.transaction(async (tx) => {
      await lockRerankerTenant(tx, tenantId);
      const deleted = await tx.query<{ is_active: boolean }>("DELETE FROM knowledge_rerankers WHERE tenant_id=$1 AND reranker_key=$2 RETURNING is_active", [tenantId, key]);
      if (!deleted.rows[0]) throw new Error(`reranker not found: ${key}`);
      if (deleted.rows[0].is_active) {
        await tx.query("UPDATE knowledge_rerankers SET is_active=TRUE WHERE tenant_id=$1 AND reranker_key=(SELECT reranker_key FROM knowledge_rerankers WHERE tenant_id=$1 ORDER BY created_at,reranker_key LIMIT 1)", [tenantId]);
      }
      const active = await tx.query<{ reranker_key: string }>("SELECT reranker_key FROM knowledge_rerankers WHERE tenant_id=$1 AND is_active", [tenantId]);
      return { next_active_key: active.rows[0]?.reranker_key ?? null };
    });
  }
}

function lockVectorizerTenant(executor: KnowledgePostgresExecutor, tenantId: string): Promise<unknown> {
  return executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2041549321))", [tenantId]);
}

function lockRerankerTenant(executor: KnowledgePostgresExecutor, tenantId: string): Promise<unknown> {
  return executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1380270923))", [tenantId]);
}
