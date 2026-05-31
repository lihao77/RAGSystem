import type {
  McpRegistryInstall,
  McpServerConfig,
  McpServerCreate,
  McpServerListItem,
  McpServerPayload,
  McpServerStatus,
} from "../contracts/mcp.js";

export class McpServiceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "McpServiceError";
    this.statusCode = statusCode;
  }
}

export class McpService {
  private readonly servers = new Map<string, McpServerConfig>();

  searchRegistry(input: {
    search?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    latestOnly?: boolean | undefined;
  }): { items: unknown[]; count: number; next_cursor: string | null; search: string; latest_only: boolean } {
    return {
      items: [],
      count: 0,
      next_cursor: null,
      search: input.search?.trim() ?? "",
      latest_only: input.latestOnly ?? true,
    };
  }

  listServers(): McpServerListItem[] {
    return Array.from(this.servers.values()).map((server) => ({
      ...cloneServer(server),
      ...defaultStatus(),
    }));
  }

  addServer(payload: McpServerCreate): { name: string } {
    const config = normalizeServerConfig(payload);
    if (this.servers.has(config.name)) {
      throw new McpServiceError(`MCP Server 已存在: ${config.name}`, 400);
    }
    config.created_at = new Date().toISOString();
    this.servers.set(config.name, config);
    return { name: config.name };
  }

  updateServer(serverName: string, payload: McpServerPayload): McpServerStatus & { status: "disconnected" } {
    const existing = this.servers.get(serverName);
    if (!existing) {
      throw new McpServiceError(`MCP Server not found: ${serverName}`, 404);
    }
    const merged = normalizeServerConfig({
      ...existing,
      ...payload,
      name: serverName,
    });
    if (existing.created_at !== undefined) {
      merged.created_at = existing.created_at;
    }
    merged.updated_at = new Date().toISOString();
    this.servers.set(serverName, merged);
    return defaultStatus();
  }

  deleteServer(serverName: string): void {
    if (!this.servers.delete(serverName)) {
      throw new McpServiceError(`MCP Server 不存在: ${serverName}`, 404);
    }
  }

  ensureServer(serverName: string): McpServerConfig {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new McpServiceError(`MCP Server not found: ${serverName}`, 404);
    }
    return server;
  }

  listServerTools(serverName: string): { server_name: string; tool_count: number; tools: unknown[] } {
    this.ensureServer(serverName);
    return {
      server_name: serverName,
      tool_count: 0,
      tools: [],
    };
  }

  listAllTools(): { tool_count: number; tools: unknown[] } {
    return {
      tool_count: 0,
      tools: [],
    };
  }

  validateRegistryInstall(payload: McpRegistryInstall): void {
    if (!payload.install_option) {
      throw new McpServiceError("`install_option` is required", 400);
    }
  }
}

function normalizeServerConfig(payload: McpServerCreate | (McpServerPayload & { name: string })): McpServerConfig {
  const name = String(payload.name ?? "").trim();
  if (!name) {
    throw new McpServiceError("name is required", 400);
  }
  const transport = payload.transport ?? "stdio";
  const config: McpServerConfig = {
    name,
    display_name: String(payload.display_name ?? ""),
    transport,
    command: payload.command === undefined ? null : nullableString(payload.command),
    args: Array.isArray(payload.args) ? payload.args.map((item) => String(item)) : [],
    env: stringRecord(payload.env),
    url: payload.url === undefined ? null : nullableString(payload.url),
    headers: stringRecord(payload.headers),
    enabled: payload.enabled ?? true,
    auto_connect: payload.auto_connect ?? true,
    timeout: payload.timeout ?? 30,
    risk_level: payload.risk_level ?? "medium",
  };

  if (transport === "stdio" && !config.command?.trim()) {
    throw new McpServiceError("stdio MCP Server 必须填写 command", 400);
  }
  if (transport !== "stdio" && !config.url?.trim()) {
    throw new McpServiceError(`${transport} MCP Server 必须填写 url`, 400);
  }
  copyExtraFields(config, payload);
  return config;
}

function defaultStatus(): McpServerStatus & { status: "disconnected" } {
  return {
    status: "disconnected",
    tool_count: 0,
    tools: [],
    error_message: null,
  };
}

function nullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return String(value ?? "");
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([key, current]) => [key, String(current ?? "")]));
}

function copyExtraFields(config: McpServerConfig, payload: Record<string, unknown>): void {
  const known = new Set([
    "name",
    "display_name",
    "transport",
    "command",
    "args",
    "env",
    "url",
    "headers",
    "enabled",
    "auto_connect",
    "timeout",
    "risk_level",
  ]);
  for (const [key, value] of Object.entries(payload)) {
    if (!known.has(key)) {
      config[key] = value;
    }
  }
}

function cloneServer(server: McpServerConfig): McpServerConfig {
  return structuredClone(server) as McpServerConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
