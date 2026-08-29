/**
 * 知识库自管模型 Provider 的 Postgres 存储（SaaS 多租户，tenant_id 隔离）。
 * 表结构经 knowledge-config-migrations v4 建（本文件只做读写）。
 */
import type {
  KnowledgeModelProvider,
  KnowledgeModelProviderKind,
  KnowledgeModelProviderStore,
} from "../../contracts/knowledge/model-providers.js";
import type { KnowledgePostgresExecutor } from "./executor.js";

function map(row: Record<string, unknown>): KnowledgeModelProvider {
  return {
    provider_key: String(row.provider_key),
    kind: (row.kind === "rerank" ? "rerank" : "embedding") as KnowledgeModelProviderKind,
    name: String(row.name),
    api_endpoint: String(row.api_endpoint),
    api_key: String(row.api_key ?? ""),
    model_name: String(row.model_name ?? ""),
    is_active: Boolean(row.is_active),
    ...(row.created_at !== undefined ? { created_at: new Date(String(row.created_at)).toISOString() } : {}),
  };
}

export class PostgresKnowledgeModelProviderStore implements KnowledgeModelProviderStore {
  constructor(private readonly executor: KnowledgePostgresExecutor) {}

  async listProviders(tenantId: string): Promise<KnowledgeModelProvider[]> {
    const result = await this.executor.query(
      "SELECT * FROM knowledge_model_providers WHERE tenant_id=$1 ORDER BY created_at, provider_key",
      [tenantId],
    );
    return result.rows.map(map);
  }

  async getProvider(tenantId: string, providerKey: string): Promise<KnowledgeModelProvider | null> {
    const result = await this.executor.query(
      "SELECT * FROM knowledge_model_providers WHERE tenant_id=$1 AND provider_key=$2",
      [tenantId, providerKey],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async upsertProvider(tenantId: string, provider: KnowledgeModelProvider, options?: { keepExistingApiKey?: boolean }): Promise<KnowledgeModelProvider> {
    let apiKey = provider.api_key;
    if (options?.keepExistingApiKey) {
      const existing = await this.getProvider(tenantId, provider.provider_key);
      apiKey = existing?.api_key ?? apiKey;
    }
    const result = await this.executor.query(
      `INSERT INTO knowledge_model_providers(tenant_id,provider_key,kind,name,api_endpoint,api_key,model_name,is_active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(tenant_id,provider_key) DO UPDATE SET
         kind=EXCLUDED.kind, name=EXCLUDED.name, api_endpoint=EXCLUDED.api_endpoint,
         api_key=EXCLUDED.api_key, model_name=EXCLUDED.model_name, is_active=EXCLUDED.is_active
       RETURNING *`,
      [tenantId, provider.provider_key, provider.kind, provider.name, provider.api_endpoint, apiKey, provider.model_name, provider.is_active],
    );
    if (!result.rows[0]) throw new Error("knowledge model provider upsert returned no row");
    return map(result.rows[0]);
  }

  async deleteProvider(tenantId: string, providerKey: string): Promise<void> {
    await this.executor.query(
      "DELETE FROM knowledge_model_providers WHERE tenant_id=$1 AND provider_key=$2",
      [tenantId, providerKey],
    );
  }
}
