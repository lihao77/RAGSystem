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
import { createMcpTransport, McpClient, McpTool, McpLogParams, normalizeLogLevel } from "./transport.js";
import { normalizeMcpTools, normalizePromptArgument } from "./config-normalization.js";
import { formatError } from "./registry.js";


export class SdkMcpClient implements McpClient {
  tools: McpTool[] = [];
  private readonly client: Client;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private stderrText = "";
  private readonly onLog?: (params: McpLogParams) => void;

  constructor(config: McpServerConfig, onDisconnect?: () => void, onLog?: (params: McpLogParams) => void) {
    this.timeoutMs = Math.max(1, config.timeout) * 1000;
    const { transport, stderr } = createMcpTransport(config);
    this.transport = transport;
    if (stderr) {
      stderr.on("data", (chunk: Uint8Array) => {
        this.stderrText += Buffer.from(chunk).toString("utf8");
        if (this.stderrText.length > 4000) {
          this.stderrText = this.stderrText.slice(-4000);
        }
      });
    }
    if (onLog) this.onLog = onLog;
    this.client = new Client(
      { name: "@ragsystem/backend-ts", version: "0.1.0" },
      { capabilities: {} },
    );
    // transport 意外断开(进程 exit / 远程断开)时通知 McpService 触发自动重连。
    this.client.onclose = () => onDisconnect?.();
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect(this.transport, { timeout: this.timeoutMs });
      const listed = await this.client.listTools(undefined, { timeout: this.timeoutMs });
      this.tools = normalizeMcpTools(listed);
      // 订阅 server logging(server 声明 logging capability 时),转发到 McpService 后端日志。
      if (this.onLog && this.client.getServerCapabilities()?.logging) {
        this.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
          this.onLog?.(notification.params as McpLogParams);
        });
        await this.client.setLoggingLevel(normalizeLogLevel(process.env.MCP_LOG_LEVEL), { timeout: this.timeoutMs }).catch((err) => {
          console.warn(`[MCP] setLoggingLevel failed: ${formatError(err)}`);
        });
      }
    } catch (error) {
      const detail = this.stderrText.trim();
      if (detail) {
        throw new Error(`${formatError(error)}: ${detail}`);
      }
      throw error;
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await this.client.callTool(
      { name: toolName, arguments: args, ...(meta ? { _meta: meta } : {}) },
      undefined,
      signal ? { signal } : undefined,
    );
    return isRecord(result) ? result : {};
  }

  close(): void {
    this.client.removeNotificationHandler("notifications/message");
    void this.client.close().catch(() => {
      // Best-effort teardown; errors here are not actionable for callers.
    });
  }

  getServerCapabilities(): McpCapabilityFaces | undefined {
    const caps = this.client.getServerCapabilities();
    if (!caps) return undefined;
    return {
      tools: Boolean(caps.tools),
      resources: Boolean(caps.resources),
      prompts: Boolean(caps.prompts),
      logging: Boolean(caps.logging),
    };
  }

  async listResources(): Promise<McpResource[]> {
    const caps = this.client.getServerCapabilities();
    if (!caps?.resources) return [];
    try {
      const result = await this.client.listResources(undefined, { timeout: this.timeoutMs });
      const resources = isRecord(result) && Array.isArray(result.resources) ? result.resources : [];
      return resources.flatMap((r): McpResource[] => {
        if (!isRecord(r) || typeof r.uri !== "string" || typeof r.name !== "string") return [];
        const item: McpResource = { uri: r.uri, name: r.name };
        if (typeof r.description === "string") item.description = r.description;
        if (typeof r.mimeType === "string") item.mimeType = r.mimeType;
        if (typeof r.size === "number") item.size = r.size;
        return [item];
      });
    } catch (error) {
      console.warn("[MCP] listResources failed:", error);
      return [];
    }
  }

  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = await this.client.readResource({ uri }, { timeout: this.timeoutMs }) as unknown;
    const contents = isRecord(result) && Array.isArray(result.contents) ? result.contents : [];
    return contents.flatMap((c): McpResourceContent[] => {
      if (!isRecord(c) || typeof c.uri !== "string") return [];
      const item: McpResourceContent = { uri: c.uri };
      if (typeof c.text === "string") item.text = c.text;
      if (typeof c.blob === "string") item.blob = c.blob;
      return [item];
    });
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const caps = this.client.getServerCapabilities();
    if (!caps?.prompts) return [];
    try {
      const result = await this.client.listPrompts(undefined, { timeout: this.timeoutMs });
      const prompts = isRecord(result) && Array.isArray(result.prompts) ? result.prompts : [];
      return prompts.flatMap((p): McpPrompt[] => {
        if (!isRecord(p) || typeof p.name !== "string") return [];
        const item: McpPrompt = { name: p.name };
        if (typeof p.description === "string") item.description = p.description;
        if (Array.isArray(p.arguments)) item.arguments = p.arguments.map(normalizePromptArgument);
        return [item];
      });
    } catch (error) {
      console.warn("[MCP] listPrompts failed:", error);
      return [];
    }
  }

  async getPrompt(name: string, args?: Record<string, unknown>): Promise<McpPromptMessage[]> {
    const result = await this.client.getPrompt(
      { name, ...(args ? { arguments: args as Record<string, string> } : {}) },
      { timeout: this.timeoutMs },
    ) as unknown;
    const messages = isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
    return messages.flatMap((m): McpPromptMessage[] => {
      if (!isRecord(m) || typeof m.role !== "string") return [];
      return [{ role: m.role, content: m.content }];
    });
  }
}
