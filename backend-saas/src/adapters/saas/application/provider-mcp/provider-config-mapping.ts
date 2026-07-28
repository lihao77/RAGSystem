import type { McpServerConfig } from "@ragsystem/backend-core/contracts/integrations/mcp.js";
import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type {
  McpServerRecord,
  ProviderConfigRecord,
} from "@ragsystem/backend-core/contracts/integrations/provider-mcp-repository.js";

/** Map a PostgreSQL provider row into the runtime ModelProviderConfig shape. */
export function toModelProviderConfig(record: ProviderConfigRecord): ModelProviderConfig {
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

/** Map a PostgreSQL MCP row into the runtime McpServerConfig shape. */
export function toMcpServerConfig(record: McpServerRecord): McpServerConfig {
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

/** Persistable MCP config: strip connection-runtime fields that must not be stored. */
export function toPersistedMcpConfig(server: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...server };
  for (const key of [
    "status",
    "tool_count",
    "tools",
    "error_message",
    "resource_count",
    "prompt_count",
    "capability_faces",
  ]) {
    delete copy[key];
  }
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
