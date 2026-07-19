import type { McpServerConfig, McpServerCreate, McpServerPayload } from "../../contracts/mcp.js";
import type { ModelProviderConfig, ProviderPayload } from "../../contracts/model-adapter.js";
import type { TenantId } from "../../identity/types.js";
import type {
  PostgresProviderMcpRepository,
  SaaSMcpServerRecord,
  SaaSProviderConfigRecord,
} from "../../adapters/saas/postgres/provider-mcp-repository.js";
import type { McpService } from "../../services/integrations/mcp-service.js";
import { SaaSMcpRuntimeRegistry } from "../../app/composition/saas/saas-mcp-runtime.js";

/** Tenant-scoped application facade for SaaS provider/MCP config. */
export class SaaSProviderMcpApplication {
  private readonly runtimes = new SaaSMcpRuntimeRegistry(this);

  constructor(private readonly repository: PostgresProviderMcpRepository) {}

  resolveMcpRuntime(tenantId: TenantId): Promise<McpService> {
    return this.runtimes.resolve(tenantId);
  }

  close(): void {
    this.runtimes.close();
  }

  async listProviders(tenantId: TenantId): Promise<ModelProviderConfig[]> {
    const records = await this.repository.listProviders(tenantId);
    return records.map(toModelProviderConfig);
  }

  async listMcpServers(tenantId: TenantId): Promise<McpServerConfig[]> {
    const records = await this.repository.listMcpServers(tenantId);
    return records.map(toMcpServerConfig);
  }

  async createProvider(tenantId: TenantId, payload: ProviderPayload): Promise<string> {
    const config = { ...payload };
    const name = String(config.name ?? "").trim();
    const type = String(config.provider_type ?? "").trim().toLowerCase();
    if (!name || !type || !String(config.api_key ?? "").trim()) throw new Error("Provider 配置必须包含 name, provider_type, api_key");
    const key = `${name.toLowerCase().replaceAll(" ", "_")}_${type}`;
    if (await this.repository.getProvider(tenantId, key)) throw new Error(`Provider 已存在: ${key}`);
    await this.repository.upsertProvider(tenantId, key, { ...config, name, provider_type: type });
    return key;
  }

  async updateProvider(tenantId: TenantId, key: string, payload: ProviderPayload): Promise<string> {
    const existing = await this.repository.getProvider(tenantId, key);
    if (!existing) throw new Error(`Provider 不存在: ${key}`);
    const config: Record<string, unknown> = { ...existing.config, ...payload, name: existing.config.name ?? key.split("_")[0], provider_type: existing.config.provider_type ?? key.slice(key.lastIndexOf("_") + 1) };
    if (payload.api_key !== undefined && !String(payload.api_key ?? "").trim()) config.api_key = existing.config.api_key;
    await this.repository.upsertProvider(tenantId, key, config);
    return key;
  }

  async deleteProvider(tenantId: TenantId, key: string): Promise<void> {
    if (!await this.repository.deleteProvider(tenantId, key)) throw new Error(`Provider 不存在: ${key}`);
  }

  async reorderProviders(tenantId: TenantId, keys: string[]): Promise<string[]> {
    const current = await this.repository.listProviders(tenantId);
    const known = new Set(current.map((item) => item.provider_key));
    if (keys.length !== known.size || new Set(keys).size !== keys.length || keys.some((key) => !known.has(key))) throw new Error("Provider 顺序列表必须包含全部 Provider 且不可重复");
    if (!await this.repository.reorderProviders(tenantId, keys)) throw new Error("Provider 顺序更新失败");
    return keys;
  }

  async createMcpServer(tenantId: TenantId, payload: McpServerCreate): Promise<{ name: string }> {
    const name = String(payload.name ?? "").trim();
    if (!name) throw new Error("MCP Server name is required");
    if (await this.repository.getMcpServer(tenantId, name)) throw new Error(`MCP Server 已存在: ${name}`);
    await this.repository.upsertMcpServer(tenantId, name, { ...payload, name });
    return { name };
  }

  async updateMcpServer(tenantId: TenantId, name: string, payload: McpServerPayload): Promise<McpServerConfig> {
    const existing = await this.repository.getMcpServer(tenantId, name);
    if (!existing) throw new Error(`MCP Server not found: ${name}`);
    const config = { ...existing.config, ...payload, name };
    const saved = await this.repository.upsertMcpServer(tenantId, name, config);
    return toMcpServerConfig(saved);
  }

  async deleteMcpServer(tenantId: TenantId, name: string): Promise<void> {
    if (!await this.repository.deleteMcpServer(tenantId, name)) throw new Error(`MCP Server 不存在: ${name}`);
  }
}

function toModelProviderConfig(record: SaaSProviderConfigRecord): ModelProviderConfig {
  const config = { ...record.config } as Record<string, unknown>;
  const modelMap = isRecord(config.model_map) ? config.model_map : {};
  const models = Array.isArray(config.models)
    ? config.models.filter((item): item is string => typeof item === "string")
    : Object.values(modelMap).flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((item): item is string => typeof item === "string");
  return {
    ...config,
    name: String(config.name ?? record.provider_key),
    provider_type: String(config.provider_type ?? ""),
    key: record.provider_key,
    models,
    model_map: modelMap as ModelProviderConfig["model_map"],
    is_loaded: true,
  };
}

function toMcpServerConfig(record: SaaSMcpServerRecord): McpServerConfig {
  const config = record.config;
  return {
    ...config,
    name: String(config.name ?? record.server_name),
    display_name: String(config.display_name ?? ""),
    transport: (config.transport === "sse" || config.transport === "streamable_http" ? config.transport : "stdio"),
    command: typeof config.command === "string" ? config.command : null,
    args: stringArray(config.args),
    env: stringRecord(config.env),
    url: typeof config.url === "string" ? config.url : null,
    headers: stringRecord(config.headers),
    enabled: config.enabled !== false,
    auto_connect: config.auto_connect !== false,
    timeout: numberValue(config.timeout, 30),
    risk_level: String(config.risk_level ?? "medium"),
    tool_risk_overrides: stringRecord(config.tool_risk_overrides),
    trusted: config.trusted !== false,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") result[key] = item;
  return result;
}
function numberValue(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
