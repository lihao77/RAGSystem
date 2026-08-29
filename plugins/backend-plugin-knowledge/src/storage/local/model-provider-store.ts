/**
 * 知识库自管模型 Provider 的 SQLite 存储（knowledge.db，与向量库同库）。
 * 表结构轻量：kind 限 embedding/rerank，(tenant, provider_key) 唯一。
 */
import type {
  KnowledgeModelProvider,
  KnowledgeModelProviderStore,
  KnowledgeModelProviderKind,
} from "../../contracts/knowledge/model-providers.js";

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS knowledge_model_providers (
    provider_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('embedding', 'rerank')),
    name TEXT NOT NULL,
    api_endpoint TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    model_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (provider_key)
  );
`;

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

export class SqliteKnowledgeModelProviderStore implements KnowledgeModelProviderStore {
  constructor(private readonly db: SqliteDb) {
    this.db.exec(TABLE_DDL);
  }

  async listProviders(tenantId: string): Promise<KnowledgeModelProvider[]> {
    void tenantId; // 单租户单库：provider_key 即主键，tenant 隔离由库文件承担
    const rows = this.db.prepare("SELECT provider_key, kind, name, api_endpoint, api_key, model_name, created_at, is_active FROM knowledge_model_providers ORDER BY created_at ASC, provider_key ASC").all() as Array<Record<string, unknown>>;
    return rows.map(rowFromDb);
  }

  async getProvider(tenantId: string, providerKey: string): Promise<KnowledgeModelProvider | null> {
    void tenantId;
    const row = this.db.prepare("SELECT provider_key, kind, name, api_endpoint, api_key, model_name, created_at, is_active FROM knowledge_model_providers WHERE provider_key = ?").get(providerKey) as Record<string, unknown> | undefined;
    return row ? rowFromDb(row) : null;
  }

  async upsertProvider(tenantId: string, provider: KnowledgeModelProvider, options?: { keepExistingApiKey?: boolean }): Promise<KnowledgeModelProvider> {
    void tenantId;
    let apiKey = provider.api_key;
    if (options?.keepExistingApiKey) {
      const existing = await this.getProvider(tenantId, provider.provider_key);
      apiKey = existing?.api_key ?? apiKey;
    }
    this.db.prepare(`
      INSERT INTO knowledge_model_providers (provider_key, kind, name, api_endpoint, api_key, model_name, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_key) DO UPDATE SET
        kind = excluded.kind, name = excluded.name, api_endpoint = excluded.api_endpoint,
        api_key = excluded.api_key, model_name = excluded.model_name, is_active = excluded.is_active
    `).run(provider.provider_key, provider.kind, provider.name, provider.api_endpoint, apiKey, provider.model_name, provider.is_active ? 1 : 0);
    return (await this.getProvider(tenantId, provider.provider_key))!;
  }

  async deleteProvider(tenantId: string, providerKey: string): Promise<void> {
    void tenantId;
    this.db.prepare("DELETE FROM knowledge_model_providers WHERE provider_key = ?").run(providerKey);
  }
}

function rowFromDb(row: Record<string, unknown>): KnowledgeModelProvider {
  return {
    provider_key: String(row.provider_key ?? ""),
    kind: (row.kind === "rerank" ? "rerank" : "embedding") as KnowledgeModelProviderKind,
    name: String(row.name ?? ""),
    api_endpoint: String(row.api_endpoint ?? ""),
    api_key: String(row.api_key ?? ""),
    model_name: String(row.model_name ?? ""),
    is_active: Boolean(row.is_active),
    ...(row.created_at !== undefined ? { created_at: String(row.created_at) } : {}),
  };
}
