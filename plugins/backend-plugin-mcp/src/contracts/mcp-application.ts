import type {
  McpRegistryInstall,
  McpServerConfig,
  McpServerCreate,
  McpServerListItem,
  McpServerPayload,
  McpServerStatus,
  McpResourceContent,
  McpPromptMessage,
} from "./mcp.js";
import type { ToolExecutionResult } from "@ragsystem/agent-sdk";

export interface McpApplication {
  searchRegistry(input: {
    search?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    latestOnly?: boolean | undefined;
  }): Promise<{ items: unknown[]; count: number; next_cursor: string | null; search: string; latest_only: boolean }>;
  installServerFromRegistry(payload: McpRegistryInstall): Promise<{ name: string; status: McpServerStatus["status"] } & McpServerConfig>;
  listServers(): Promise<McpServerListItem[]>;
  addServer(payload: McpServerCreate): Promise<{ name: string }>;
  updateServer(serverName: string, payload: McpServerPayload): Promise<McpServerStatus | McpServerConfig>;
  deleteServer(serverName: string): Promise<void>;
  connectServer(serverName: string): Promise<McpServerStatus>;
  disconnectServer(serverName: string): Promise<void>;
  testServer(serverName: string): Promise<{ success: boolean; message: string; tool_count: number }>;
  listServerTools(serverName: string): Promise<{ server_name: string; tool_count: number; tools: unknown[] }>;
  listAllTools(): Promise<{ tool_count: number; tools: unknown[] }>;
  listAllPrompts(): Promise<{ prompt_count: number; prompts: unknown[] }>;
  getServerMetrics(serverName: string): Promise<Record<string, unknown>>;
  listServerResources(serverName: string): Promise<Record<string, unknown>>;
  readResource(serverName: string, uri: string): Promise<McpResourceContent[]>;
  listServerPrompts(serverName: string): Promise<Record<string, unknown>>;
  getPrompt(serverName: string, name: string, args?: Record<string, unknown>): Promise<McpPromptMessage[]>;
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}
