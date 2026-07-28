import type { McpApplication } from "../../contracts/mcp-application.js";
import type { McpRepository } from "./repository.js";
import type {
  McpRegistryInstall,
  McpServerCreate,
  McpServerListItem,
  McpServerPayload,
  McpServerStatus,
} from "../../contracts/mcp.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import { buildServerConfigFromRegistryInstall } from "../../services/mcp/registry.js";
import { normalizeServerConfig } from "../../services/mcp/config-normalization.js";
import { McpServiceError, type McpService } from "../../mcp-service.js";
import type { SaaSMcpRuntime } from "./runtime-service.js";
import { toPersistedMcpConfig } from "./config-mapping.js";

/**
 * Tenant-bound MCP application.
 * PostgreSQL is the sole source of truth; McpService is only the connection runtime projection.
 * Mutation order: validate → write repository → refresh runtime from store.
 */
export class SaaSMcpApplication implements McpApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly runtimeService: SaaSMcpRuntime,
    private readonly repository: McpRepository,
  ) {}

  async searchRegistry(input: Parameters<McpService["searchRegistry"]>[0]) {
    return (await this.runtime()).searchRegistry(input);
  }

  async installServerFromRegistry(payload: McpRegistryInstall) {
    const config = buildServerConfigFromRegistryInstall(payload);
    if (await this.repository.getMcpServer(this.tenantId, config.name)) {
      throw new McpServiceError(`MCP Server 已存在: ${config.name}`, 400);
    }
    const now = new Date().toISOString();
    const persisted = {
      ...toPersistedMcpConfig(config as unknown as Record<string, unknown>),
      created_at: now,
      updated_at: now,
    };
    await this.repository.upsertMcpServer(this.tenantId, config.name, persisted);
    const runtime = await this.runtime();
    const status = await connectIfPresent(runtime, config.name);
    return {
      ...config,
      name: config.name,
      status: status.status,
    };
  }

  async listServers() {
    return (await this.runtime()).listServers();
  }

  async addServer(payload: McpServerCreate) {
    const config = normalizeServerConfig(payload as unknown as Record<string, unknown>);
    if (await this.repository.getMcpServer(this.tenantId, config.name)) {
      throw new McpServiceError(`MCP Server 已存在: ${config.name}`, 400);
    }
    const now = new Date().toISOString();
    const persisted = {
      ...toPersistedMcpConfig(config as unknown as Record<string, unknown>),
      created_at: now,
      updated_at: now,
    };
    await this.repository.upsertMcpServer(this.tenantId, config.name, persisted);
    await this.runtime();
    return { name: config.name };
  }

  async updateServer(serverName: string, payload: McpServerPayload) {
    const existing = await this.repository.getMcpServer(this.tenantId, serverName);
    if (!existing) {
      throw new McpServiceError(`MCP Server not found: ${serverName}`, 404);
    }
    const merged = normalizeServerConfig({
      ...existing.config,
      ...payload,
      name: serverName,
    });
    if (typeof existing.config.created_at === "string") {
      merged.created_at = existing.config.created_at;
    } else if (existing.created_at) {
      merged.created_at = existing.created_at;
    }
    merged.updated_at = new Date().toISOString();
    await this.repository.upsertMcpServer(
      this.tenantId,
      serverName,
      toPersistedMcpConfig(merged as unknown as Record<string, unknown>),
    );
    const runtime = await this.runtime();
    const server = runtime.listServers().find((item) => item.name === serverName);
    if (!server) {
      throw new McpServiceError(`MCP Server not found: ${serverName}`, 404);
    }
    return {
      status: server.status,
      tool_count: server.tool_count,
      tools: server.tools,
      error_message: server.error_message,
      resource_count: server.resource_count,
      prompt_count: server.prompt_count,
    } satisfies McpServerStatus;
  }

  async deleteServer(serverName: string) {
    if (!await this.repository.deleteMcpServer(this.tenantId, serverName)) {
      throw new McpServiceError(`MCP Server 不存在: ${serverName}`, 404);
    }
    await this.runtime();
  }

  async connectServer(serverName: string) {
    return (await this.runtime()).connectServer(serverName);
  }

  async disconnectServer(serverName: string) {
    (await this.runtime()).disconnectServer(serverName, { manual: true });
  }

  async testServer(serverName: string) {
    return (await this.runtime()).testServer(serverName);
  }

  async listServerTools(serverName: string) {
    return (await this.runtime()).listServerTools(serverName);
  }

  async listAllTools() {
    return (await this.runtime()).listAllTools();
  }

  async listAllPrompts() {
    return (await this.runtime()).listAllPrompts();
  }

  async getServerMetrics(serverName: string) {
    return (await this.runtime()).getServerMetrics(serverName);
  }

  async listServerResources(serverName: string) {
    return (await this.runtime()).listServerResources(serverName);
  }

  async readResource(serverName: string, uri: string) {
    return (await this.runtime()).readResource(serverName, uri);
  }

  async listServerPrompts(serverName: string) {
    return (await this.runtime()).listServerPrompts(serverName);
  }

  async getPrompt(serverName: string, name: string, args?: Record<string, unknown>) {
    return (await this.runtime()).getPrompt(serverName, name, args);
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>) {
    return (await this.runtime()).callTool(serverName, toolName, args);
  }

  private runtime(): Promise<McpService> {
    return this.runtimeService.refresh();
  }
}

async function connectIfPresent(
  runtime: McpService,
  serverName: string,
): Promise<{ status: McpServerListItem["status"] }> {
  const server = runtime.listServers().find((item) => item.name === serverName);
  if (!server) {
    return { status: "disconnected" };
  }
  if (!server.enabled || !server.auto_connect) {
    return { status: server.status };
  }
  try {
    return await runtime.connectServer(serverName);
  } catch {
    return { status: runtime.listServers().find((item) => item.name === serverName)?.status ?? "disconnected" };
  }
}
