import type { SecretResolver } from "../../../contracts/integrations/secret-resolver.js";
import type { TenantId } from "../../../identity/types.js";
import type { McpServerRecord, ProviderConfigRecord, ProviderMcpRepository } from "../../../contracts/provider-mcp-repository.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

export type SaaSProviderConfigRecord = ProviderConfigRecord;
export type SaaSMcpServerRecord = McpServerRecord;
const record = (row: Record<string, unknown>): ProviderConfigRecord => ({ tenant_id: row.tenant_id as TenantId, provider_key: String(row.provider_key), config: (row.config ?? {}) as Record<string, unknown>, created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString() });
const server = (row: Record<string, unknown>): McpServerRecord => ({ tenant_id: row.tenant_id as TenantId, server_name: String(row.server_name), config: (row.config ?? {}) as Record<string, unknown>, created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString() });

export class PostgresProviderMcpRepository implements ProviderMcpRepository {
  constructor(private readonly executor: PostgresMemoryExecutor, private readonly secrets?: SecretResolver) {}
  async listProviders(tenantId: TenantId): Promise<SaaSProviderConfigRecord[]> { const r = await this.executor.query("SELECT * FROM saas_provider_configs WHERE tenant_id=$1 ORDER BY COALESCE((config->>'provider_order')::int, 2147483647), provider_key", [tenantId]); return Promise.all(r.rows.map((row) => this.hydrateProvider(record(row)))); }
  async getProvider(tenantId: TenantId, key: string): Promise<SaaSProviderConfigRecord | null> { const r = await this.executor.query("SELECT * FROM saas_provider_configs WHERE tenant_id=$1 AND provider_key=$2", [tenantId, key]); return r.rows[0] ? this.hydrateProvider(record(r.rows[0])) : null; }
  async upsertProvider(tenantId: TenantId, key: string, config: Record<string, unknown>): Promise<SaaSProviderConfigRecord> { const prepared = await this.prepare(tenantId, "provider", key, config); const r = await this.executor.query("INSERT INTO saas_provider_configs(tenant_id,provider_key,config) VALUES($1,$2,$3::jsonb) ON CONFLICT (tenant_id,provider_key) DO UPDATE SET config=EXCLUDED.config,updated_at=CURRENT_TIMESTAMP RETURNING *", [tenantId, key, JSON.stringify(prepared)]); return this.hydrateProvider(record(r.rows[0]!)); }
  async deleteProvider(tenantId: TenantId, key: string): Promise<boolean> { const r = await this.executor.query("DELETE FROM saas_provider_configs WHERE tenant_id=$1 AND provider_key=$2", [tenantId, key]); return Number(r.rowCount ?? 0) > 0; }
  async reorderProviders(tenantId: TenantId, keys: string[]): Promise<boolean> {
    return this.executor.transaction(async (tx) => {
      for (const [order, key] of keys.entries()) {
        const result = await tx.query("UPDATE saas_provider_configs SET config=jsonb_set(config, '{provider_order}', to_jsonb($3::int), true), updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND provider_key=$2", [tenantId, key, order]);
        if (Number(result.rowCount ?? 0) === 0) return false;
      }
      return true;
    });
  }
  async listMcpServers(tenantId: TenantId): Promise<SaaSMcpServerRecord[]> { const r = await this.executor.query("SELECT * FROM saas_mcp_servers WHERE tenant_id=$1 ORDER BY server_name", [tenantId]); return Promise.all(r.rows.map((row) => this.hydrateMcp(server(row)))); }
  async getMcpServer(tenantId: TenantId, name: string): Promise<SaaSMcpServerRecord | null> { const r = await this.executor.query("SELECT * FROM saas_mcp_servers WHERE tenant_id=$1 AND server_name=$2", [tenantId, name]); return r.rows[0] ? this.hydrateMcp(server(r.rows[0])) : null; }
  async upsertMcpServer(tenantId: TenantId, name: string, config: Record<string, unknown>): Promise<SaaSMcpServerRecord> { const prepared = await this.prepare(tenantId, "mcp", name, config); const r = await this.executor.query("INSERT INTO saas_mcp_servers(tenant_id,server_name,config) VALUES($1,$2,$3::jsonb) ON CONFLICT (tenant_id,server_name) DO UPDATE SET config=EXCLUDED.config,updated_at=CURRENT_TIMESTAMP RETURNING *", [tenantId, name, JSON.stringify(prepared)]); return this.hydrateMcp(server(r.rows[0]!)); }
  async deleteMcpServer(tenantId: TenantId, name: string): Promise<boolean> { const r = await this.executor.query("DELETE FROM saas_mcp_servers WHERE tenant_id=$1 AND server_name=$2", [tenantId, name]); return Number(r.rowCount ?? 0) > 0; }
  private async prepare(tenantId: TenantId, purpose: string, resourceId: string, config: Record<string, unknown>): Promise<Record<string, unknown>> { const copy = structuredClone(config); for (const item of collectSecrets(copy)) { if (!this.secrets) throw new Error("Provider/MCP secret resolver is required for sensitive configuration"); await this.secrets.mutate({ tenantId, purpose, resourceId, field: item.field }, { kind: "set", value: item.value }); setPath(copy, item.path, { __secret_ref: item.field }); } return copy; }
  private async hydrateProvider(value: SaaSProviderConfigRecord): Promise<SaaSProviderConfigRecord> { return { ...value, config: await hydrate(this.secrets, value.tenant_id, "provider", value.provider_key, value.config) }; }
  private async hydrateMcp(value: SaaSMcpServerRecord): Promise<SaaSMcpServerRecord> { return { ...value, config: await hydrate(this.secrets, value.tenant_id, "mcp", value.server_name, value.config) }; }
}

type SecretItem = { path: string[]; field: string; value: string };
const SECRET_KEY = /(^|_)(api[-_]?key|token|secret|password|authorization|private[-_]?key)$/i;
function collectSecrets(value: unknown, path: string[] = []): SecretItem[] { if (!value || typeof value !== "object" || Array.isArray(value)) return []; const result: SecretItem[] = []; for (const [key, child] of Object.entries(value as Record<string, unknown>)) { const next = [...path, key]; if (typeof child === "string" && (SECRET_KEY.test(key) || path.includes("env") || path.includes("headers"))) result.push({ path: next, field: `config.${next.join(".")}`, value: child }); else result.push(...collectSecrets(child, next)); } return result; }
function setPath(target: Record<string, unknown>, path: string[], value: unknown): void { let current = target; for (const key of path.slice(0, -1)) { if (!current[key] || typeof current[key] !== "object") current[key] = {}; current = current[key] as Record<string, unknown>; } current[path[path.length - 1]!] = value; }
async function hydrate(secrets: SecretResolver | undefined, tenantId: TenantId, purpose: string, resourceId: string, value: Record<string, unknown>): Promise<Record<string, unknown>> { const copy = structuredClone(value); for (const item of collectRefs(copy)) { if (!secrets) throw new Error("Provider/MCP secret resolver is required to read sensitive configuration"); setPath(copy, item.path, await secrets.resolve({ tenantId, purpose, resourceId, field: item.field }) ?? ""); } return copy; }
function collectRefs(value: unknown, path: string[] = []): Array<{ path: string[]; field: string }> { if (!value || typeof value !== "object" || Array.isArray(value)) return []; const result: Array<{ path: string[]; field: string }> = []; for (const [key, child] of Object.entries(value as Record<string, unknown>)) { const next = [...path, key]; if (child && typeof child === "object" && !Array.isArray(child) && "__secret_ref" in child) result.push({ path: next, field: String((child as { __secret_ref: unknown }).__secret_ref) }); else result.push(...collectRefs(child, next)); } return result; }
