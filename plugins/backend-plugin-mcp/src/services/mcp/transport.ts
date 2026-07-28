import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Stream } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  externalCallPolicy,
  isRetryableHttpStatus,
  RetryableHttpError,
  type ExternalCallMetrics,
} from "@ragsystem/agent-llm";
import YAML from "yaml";

import type {
  McpCapabilityFaces,
  McpPrompt,
  McpPromptArgument,
  McpPromptMessage,
  McpRegistryInstall,
  McpResource,
  McpResourceContent,
  McpServerConfig,
  McpServerCreate,
  McpServerListItem,
  McpServerPayload,
  McpServerStatus,
  McpToolMetrics,
} from "../../contracts/mcp.js";
import type { RiskLevel } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import type { ToolExecutionResult, ToolResultMedia } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import { resolveSpawnCommand } from "./config-normalization.js";


export function createMcpTransport(config: McpServerConfig): { transport: Transport; stderr: Stream | null } {
  if (config.transport === "stdio") {
    const resolved = resolveSpawnCommand(config.command ?? "", config.args);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
    Object.assign(env, config.env);
    const transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env,
      stderr: "pipe",
    });
    return { transport, stderr: transport.stderr };
  }

  const url = new URL(config.url ?? "");
  const headers = config.headers;
  if (config.transport === "streamable_http") {
    // StreamableHTTPClientTransport exposes `sessionId: string | undefined`, which collides with the
    // Transport interface under exactOptionalPropertyTypes; the runtime contract is unchanged.
    return {
      transport: new StreamableHTTPClientTransport(url, { requestInit: { headers } }) as unknown as Transport,
      stderr: null,
    };
  }
  // SSEClientTransport injects requestInit.headers into both the GET event stream and POSTs.
  return {
    transport: new SSEClientTransport(url, { requestInit: { headers } }),
    stderr: null,
  };
}

export interface McpClient {
  tools: McpTool[];
  connect(): Promise<void>;
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  getServerCapabilities(): McpCapabilityFaces | undefined;
  listResources(): Promise<McpResource[]>;
  readResource(uri: string): Promise<McpResourceContent[]>;
  listPrompts(): Promise<McpPrompt[]>;
  getPrompt(name: string, args?: Record<string, unknown>): Promise<McpPromptMessage[]>;
  close(): void;
}

export interface McpConnectionState {
  serverName: string;
  config: McpServerConfig;
  status: McpServerStatus["status"];
  errorMessage: string | null;
  tools: McpTool[];
  client: McpClient | null;
  capabilities: McpCapabilityFaces | undefined;
  resources: McpResource[];
  prompts: McpPrompt[];
  reconnectAttempts: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

/** MCP 2025 规范的 tool.annotations——server 自声明的行为 hint(SDK 规范明示 hint 不可信源)。 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** MCP logging notification 参数(server → client 的日志消息)。 */
export interface McpLogParams {
  level: McpLogLevel;
  logger?: string;
  data: unknown;
}

export const MCP_LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const;
export type McpLogLevel = typeof MCP_LOG_LEVELS[number];

/** 从 env MCP_LOG_LEVEL 读 logging level(默认 info),非法值回退 info。 */
export function normalizeLogLevel(value: string | undefined): McpLogLevel {
  return MCP_LOG_LEVELS.includes(value as McpLogLevel) ? (value as McpLogLevel) : "info";
}

export interface RuntimeMcpToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  source: "mcp";
  category: "mcp";
  riskLevel: RiskLevel;
  server_name: string;
  original_tool_name: string;
  annotations?: McpToolAnnotations;
  usage_contract?: string[];
  returns?: { description: string; shape: Record<string, unknown> };
}
