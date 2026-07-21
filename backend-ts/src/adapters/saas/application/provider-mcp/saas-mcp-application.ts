import type { McpApplication } from "../../../../contracts/application/mcp-application.js";
import type { ProviderMcpRepository } from "../../../../contracts/integrations/provider-mcp-repository.js";
import type { McpRegistryInstall, McpServerCreate, McpServerPayload } from "../../../../contracts/integrations/mcp.js";
import type { TenantId } from "../../../../identity/types.js";
import { buildServerConfigFromRegistryInstall } from "../../../../services/integrations/mcp/registry.js";
import type { McpService } from "../../../../services/integrations/mcp-service.js";
import type { SaaSProviderMcpApplication } from "./saas-provider-mcp-application.js";

/** Tenant-bound MCP application. Runtime state is hydrated from the PostgreSQL config adapter. */
export class SaaSMcpApplication implements McpApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly config: SaaSProviderMcpApplication,
    private readonly repository: ProviderMcpRepository,
  ) {}

  async searchRegistry(input: Parameters<McpService["searchRegistry"]>[0]) {
    const runtime = await this.runtime();
    return runtime.searchRegistry(input);
  }

  async installServerFromRegistry(payload: McpRegistryInstall) {
    const runtime = await this.runtime();
    const snapshot = snapshotServers(runtime);
    const config = buildServerConfigFromRegistryInstall(payload);
    try {
      const result = await runtime.installServerFromRegistry(payload);
      await this.repository.upsertMcpServer(this.tenantId, config.name, config as Record<string, unknown>);
      return result;
    } catch (error) {
      await restoreServers(runtime, snapshot);
      throw error;
    }
  }

  async listServers() { return (await this.runtime()).listServers(); }

  async addServer(payload: McpServerCreate) {
    const runtime = await this.runtime();
    const snapshot = snapshotServers(runtime);
    try {
      const result = await runtime.addServer(payload);
      const server = runtime.listServers().find((item) => item.name === result.name);
      if (!server) throw new Error(`MCP Server not found: ${result.name}`);
      await this.repository.upsertMcpServer(this.tenantId, result.name, stripRuntimeStatus(server));
      return result;
    } catch (error) {
      await restoreServers(runtime, snapshot);
      throw error;
    }
  }

  async updateServer(serverName: string, payload: McpServerPayload) {
    const runtime = await this.runtime();
    const snapshot = snapshotServers(runtime);
    try {
      const result = await runtime.updateServer(serverName, payload);
      const server = runtime.listServers().find((item) => item.name === serverName);
      if (!server) throw new Error(`MCP Server not found: ${serverName}`);
      await this.repository.upsertMcpServer(this.tenantId, serverName, stripRuntimeStatus(server));
      return result;
    } catch (error) {
      await restoreServers(runtime, snapshot);
      throw error;
    }
  }

  async deleteServer(serverName: string) {
    const runtime = await this.runtime();
    const snapshot = snapshotServers(runtime);
    try {
      runtime.deleteServer(serverName);
      if (!await this.repository.deleteMcpServer(this.tenantId, serverName)) throw new Error(`MCP Server 不存在: ${serverName}`);
    } catch (error) {
      await restoreServers(runtime, snapshot);
      throw error;
    }
  }

  async connectServer(serverName: string) { return (await this.runtime()).connectServer(serverName); }
  async disconnectServer(serverName: string) { (await this.runtime()).disconnectServer(serverName, { manual: true }); }
  async testServer(serverName: string) { return (await this.runtime()).testServer(serverName); }
  async listServerTools(serverName: string) { return (await this.runtime()).listServerTools(serverName); }
  async listAllTools() { return (await this.runtime()).listAllTools(); }
  async listAllPrompts() { return (await this.runtime()).listAllPrompts(); }
  async getServerMetrics(serverName: string) { return (await this.runtime()).getServerMetrics(serverName); }
  async listServerResources(serverName: string) { return (await this.runtime()).listServerResources(serverName); }
  async readResource(serverName: string, uri: string) { return (await this.runtime()).readResource(serverName, uri); }
  async listServerPrompts(serverName: string) { return (await this.runtime()).listServerPrompts(serverName); }
  async getPrompt(serverName: string, name: string, args?: Record<string, unknown>) { return (await this.runtime()).getPrompt(serverName, name, args); }
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>) { return (await this.runtime()).callTool(serverName, toolName, args); }

  private runtime(): Promise<McpService> { return this.config.resolveMcpRuntime(this.tenantId); }
}

function stripRuntimeStatus(server: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...server };
  for (const key of ["status", "tool_count", "tools", "error_message", "resource_count", "prompt_count", "capability_faces"]) delete copy[key];
  return copy;
}

function snapshotServers(runtime: McpService): Record<string, unknown>[] {
  return runtime.listServers().map((server) => stripRuntimeStatus(server));
}

async function restoreServers(runtime: McpService, snapshot: Record<string, unknown>[]): Promise<void> {
  for (const current of runtime.listServers()) runtime.deleteServer(current.name);
  for (const server of snapshot) await runtime.addServer(server as McpServerCreate);
}
