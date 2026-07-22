import type { McpApplication } from "../../../../contracts/application/mcp-application.js";
import type {
  McpRegistryInstall,
  McpServerCreate,
  McpServerPayload,
} from "../../../../contracts/integrations/mcp.js";
import type { McpService } from "../../../../services/integrations/mcp-service.js";

export class LocalMcpApplication implements McpApplication {
  constructor(private readonly service: McpService) {}

  async searchRegistry(input: Parameters<McpService["searchRegistry"]>[0]) { return this.service.searchRegistry(input); }
  async installServerFromRegistry(payload: McpRegistryInstall) { return this.service.installServerFromRegistry(payload); }
  async listServers() { return this.service.listServers(); }
  async addServer(payload: McpServerCreate) { return this.service.addServer(payload); }
  async updateServer(serverName: string, payload: McpServerPayload) { return this.service.updateServer(serverName, payload); }
  async deleteServer(serverName: string) { this.service.deleteServer(serverName); }
  async connectServer(serverName: string) { return this.service.connectServer(serverName); }
  async disconnectServer(serverName: string) { this.service.disconnectServer(serverName, { manual: true }); }
  async testServer(serverName: string) { return this.service.testServer(serverName); }
  async listServerTools(serverName: string) { return this.service.listServerTools(serverName); }
  async listAllTools() { return this.service.listAllTools(); }
  async listAllPrompts() { return this.service.listAllPrompts(); }
  async getServerMetrics(serverName: string) { return this.service.getServerMetrics(serverName); }
  async listServerResources(serverName: string) { return this.service.listServerResources(serverName); }
  async readResource(serverName: string, uri: string) { return this.service.readResource(serverName, uri); }
  async listServerPrompts(serverName: string) { return this.service.listServerPrompts(serverName); }
  async getPrompt(serverName: string, name: string, args?: Record<string, unknown>) { return this.service.getPrompt(serverName, name, args); }
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>) { return this.service.callTool(serverName, toolName, args); }
}
