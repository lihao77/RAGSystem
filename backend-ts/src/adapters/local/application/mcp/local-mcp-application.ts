import type { McpApplication } from "../../../../contracts/application/mcp-application.js";
import type {
  McpRegistryInstall,
  McpServerCreate,
  McpServerPayload,
} from "../../../../contracts/integrations/mcp.js";
import type { McpService } from "../../../../services/integrations/mcp-service.js";

export class LocalMcpApplication implements McpApplication {
  constructor(private readonly service: McpService) {}

  searchRegistry(input: Parameters<McpService["searchRegistry"]>[0]) { return this.service.searchRegistry(input); }
  installServerFromRegistry(payload: McpRegistryInstall) { return this.service.installServerFromRegistry(payload); }
  listServers() { return this.service.listServers(); }
  addServer(payload: McpServerCreate) { return this.service.addServer(payload); }
  updateServer(serverName: string, payload: McpServerPayload) { return this.service.updateServer(serverName, payload); }
  deleteServer(serverName: string) { this.service.deleteServer(serverName); }
  connectServer(serverName: string) { return this.service.connectServer(serverName); }
  disconnectServer(serverName: string) { this.service.disconnectServer(serverName, { manual: true }); }
  testServer(serverName: string) { return this.service.testServer(serverName); }
  listServerTools(serverName: string) { return this.service.listServerTools(serverName); }
  listAllTools() { return this.service.listAllTools(); }
  listAllPrompts() { return this.service.listAllPrompts(); }
  getServerMetrics(serverName: string) { return this.service.getServerMetrics(serverName); }
  listServerResources(serverName: string) { return this.service.listServerResources(serverName); }
  readResource(serverName: string, uri: string) { return this.service.readResource(serverName, uri); }
  listServerPrompts(serverName: string) { return this.service.listServerPrompts(serverName); }
  getPrompt(serverName: string, name: string, args?: Record<string, unknown>) { return this.service.getPrompt(serverName, name, args); }
  callTool(serverName: string, toolName: string, args: Record<string, unknown>) { return this.service.callTool(serverName, toolName, args); }
}
