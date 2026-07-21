import type { McpServerConfig } from "../../../../contracts/integrations/mcp.js";
import type { ModelProviderConfig } from "../../../../contracts/integrations/model-adapter.js";
import type { TenantId } from "../../../../identity/types.js";
import type { McpServerRecord, ProviderConfigRecord, ProviderMcpRepository } from "../../../../contracts/integrations/provider-mcp-repository.js";
import type { McpService } from "../../../../services/integrations/mcp-service.js";
import { SaaSMcpRuntimeRegistry } from "../../composition/saas-mcp-runtime.js";

/** Tenant-scoped application facade for SaaS provider/MCP config. */
export class SaaSProviderMcpApplication {
  private readonly runtimes = new SaaSMcpRuntimeRegistry(this);

  constructor(private readonly repository: ProviderMcpRepository) {}

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

}

function toModelProviderConfig(record: ProviderConfigRecord): ModelProviderConfig {
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

function toMcpServerConfig(record: McpServerRecord): McpServerConfig {
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
