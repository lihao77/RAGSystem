import type { TenantId } from "../../../identity/types.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

export interface SaaSProviderConfigRecord { tenant_id: TenantId; provider_key: string; config: Record<string, unknown>; created_at: string; updated_at: string; }
export interface SaaSMcpServerRecord { tenant_id: TenantId; server_name: string; config: Record<string, unknown>; created_at: string; updated_at: string; }

function record(row: Record<string, unknown>): SaaSProviderConfigRecord {
  return { tenant_id: row.tenant_id as TenantId, provider_key: String(row.provider_key), config: (row.config ?? {}) as Record<string, unknown>, created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString() };
}
function server(row: Record<string, unknown>): SaaSMcpServerRecord {
  return { tenant_id: row.tenant_id as TenantId, server_name: String(row.server_name), config: (row.config ?? {}) as Record<string, unknown>, created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString() };
}

export class PostgresProviderMcpRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}
  async listProviders(tenantId: TenantId): Promise<SaaSProviderConfigRecord[]> { const r = await this.executor.query("SELECT * FROM saas_provider_configs WHERE tenant_id=$1 ORDER BY provider_key", [tenantId]); return r.rows.map(record); }
  async getProvider(tenantId: TenantId, providerKey: string): Promise<SaaSProviderConfigRecord | null> { const r = await this.executor.query("SELECT * FROM saas_provider_configs WHERE tenant_id=$1 AND provider_key=$2", [tenantId, providerKey]); return r.rows[0] ? record(r.rows[0]) : null; }
  async upsertProvider(tenantId: TenantId, providerKey: string, config: Record<string, unknown>): Promise<SaaSProviderConfigRecord> { const r = await this.executor.query("INSERT INTO saas_provider_configs(tenant_id,provider_key,config) VALUES($1,$2,$3::jsonb) ON CONFLICT (tenant_id,provider_key) DO UPDATE SET config=EXCLUDED.config,updated_at=CURRENT_TIMESTAMP RETURNING *", [tenantId, providerKey, JSON.stringify(config)]); return record(r.rows[0]!); }
  async deleteProvider(tenantId: TenantId, providerKey: string): Promise<boolean> { const r = await this.executor.query("DELETE FROM saas_provider_configs WHERE tenant_id=$1 AND provider_key=$2", [tenantId, providerKey]); return Number(r.rowCount ?? 0) > 0; }
  async listMcpServers(tenantId: TenantId): Promise<SaaSMcpServerRecord[]> { const r = await this.executor.query("SELECT * FROM saas_mcp_servers WHERE tenant_id=$1 ORDER BY server_name", [tenantId]); return r.rows.map(server); }
  async getMcpServer(tenantId: TenantId, serverName: string): Promise<SaaSMcpServerRecord | null> { const r = await this.executor.query("SELECT * FROM saas_mcp_servers WHERE tenant_id=$1 AND server_name=$2", [tenantId, serverName]); return r.rows[0] ? server(r.rows[0]) : null; }
  async upsertMcpServer(tenantId: TenantId, serverName: string, config: Record<string, unknown>): Promise<SaaSMcpServerRecord> { const r = await this.executor.query("INSERT INTO saas_mcp_servers(tenant_id,server_name,config) VALUES($1,$2,$3::jsonb) ON CONFLICT (tenant_id,server_name) DO UPDATE SET config=EXCLUDED.config,updated_at=CURRENT_TIMESTAMP RETURNING *", [tenantId, serverName, JSON.stringify(config)]); return server(r.rows[0]!); }
  async deleteMcpServer(tenantId: TenantId, serverName: string): Promise<boolean> { const r = await this.executor.query("DELETE FROM saas_mcp_servers WHERE tenant_id=$1 AND server_name=$2", [tenantId, serverName]); return Number(r.rowCount ?? 0) > 0; }
}
