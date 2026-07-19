import { isRecord } from "../../../utils/guards.js";
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
} from "../../../contracts/integrations/mcp.js";
import type { RiskLevel } from "../../../contracts/runtime/permissions.js";
import type { ToolExecutionResult, ToolResultMedia } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "../../agent/sdk/tool-results.js";
import { SdkMcpClient } from "./sdk-mcp-client.js";
import { McpConnectionState } from "./transport.js";
import {
  cloneServer,
  isConnectionChanged,
  normalizeServerConfig,
  resolveConfigPath,
  defaultStatus,
  toRuntimeMcpTool,
  buildMcpToolName,
  parseMcpToolName,
  normalizeToolResult,
} from "./config-normalization.js";
import type { RuntimeMcpToolDefinition } from "./transport.js";
import {
  buildServerConfigFromRegistryInstall,
  normalizeRegistryEntry,
  readRegistryEntries,
  readNestedString,
  formatError,
  fetchRegistryPage,
} from "./registry.js";


export const MCP_TOOL_PREFIX = "mcp__";
export const MCP_SERVERS_RELATIVE_PATH = path.join("config", "mcp", "mcp_servers.yaml");
export const REGISTRY_BASE_URL = process.env.MCP_REGISTRY_BASE_URL || "https://registry.modelcontextprotocol.io";
export const REGISTRY_TIMEOUT_MS = Math.max(1000, Number(process.env.MCP_REGISTRY_TIMEOUT ?? 15) * 1000);
export const MAX_REGISTRY_SEARCH_PAGES = 5;

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
  private readonly connections = new Map<string, McpConnectionState>();
  private readonly manuallyDisconnectedServers = new Set<string>();
  /** 主动断开(disconnectServer)时临时抑制 onclose 触发的自动重连。 */
  private readonly suppressReconnect = new Set<string>();
  /** per-server/per-tool 调用 metrics(运行时累积,不持久化)。 */
  private readonly metrics = new Map<string, Map<string, McpToolMetrics>>();
  private readonly configPath: string | null;

  constructor(options: { dataRoot?: string | undefined; configPath?: string | undefined } = {}) {
    this.configPath = resolveConfigPath(options);
    this.loadServersFromDisk();
  }

  async searchRegistry(input: {
    search?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    latestOnly?: boolean | undefined;
  }): Promise<{ items: unknown[]; count: number; next_cursor: string | null; search: string; latest_only: boolean }> {
    const search = input.search?.trim() ?? "";
    const latestOnly = input.latestOnly ?? true;
    const limit = Math.max(1, Math.min(input.limit ?? 8, 20));
    let nextCursor = input.cursor?.trim() || null;
    const seen = new Set<string>();
    const items: unknown[] = [];
    let pages = 0;
    try {
      while (items.length < limit && pages < MAX_REGISTRY_SEARCH_PAGES) {
        const body = await fetchRegistryPage(search, limit, nextCursor);
        nextCursor = readNestedString(body, ["metadata", "nextCursor"]);
        pages += 1;

        for (const entry of readRegistryEntries(body)) {
          if (!isRecord(entry)) {
            continue;
          }
          const normalized = normalizeRegistryEntry(entry);
          const key = `${String(normalized.name ?? "")}\u0000${String(normalized.version ?? "")}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          if (latestOnly && normalized.latest !== true) {
            continue;
          }
          items.push(normalized);
          if (items.length >= limit) {
            break;
          }
        }

        if (!nextCursor || !latestOnly) {
          break;
        }
      }
      return {
        items,
        count: items.length,
        next_cursor: nextCursor,
        search,
        latest_only: latestOnly,
      };
    } catch (error) {
      if (error instanceof McpServiceError) {
        throw error;
      }
      throw new McpServiceError(`Failed to query MCP Registry: ${formatError(error)}`, 502);
    }
  }

  async installServerFromRegistry(payload: McpRegistryInstall): Promise<{ name: string; status: McpServerStatus["status"] } & McpServerConfig> {
    const config = buildServerConfigFromRegistryInstall(payload);
    if (this.servers.has(config.name)) {
      throw new McpServiceError(`MCP Server 已存在: ${config.name}`, 400);
    }
    config.created_at = new Date().toISOString();
    this.servers.set(config.name, config);
    this.saveServersToDisk();
    await this.connectIfAutoEnabled(config.name);
    return {
      ...cloneServer(config),
      status: this.getServerStatus(config.name).status,
    };
  }

  listServers(): McpServerListItem[] {
    return Array.from(this.servers.values()).map((server) => ({
      ...cloneServer(server),
      ...this.getServerStatus(server.name),
    }));
  }

  async autoConnectEnabledServers(): Promise<void> {
    for (const server of this.servers.values()) {
      if (!server.enabled || !server.auto_connect) {
        continue;
      }
      const status = this.getServerStatus(server.name).status;
      if (status === "connected" || status === "connecting") {
        continue;
      }
      if (this.manuallyDisconnectedServers.has(server.name)) {
        continue;
      }
      try {
        await this.connectServer(server.name, { automatic: true });
      } catch {
        // Startup should keep running even when an optional MCP server is unavailable.
      }
    }
  }

  async addServer(payload: McpServerCreate): Promise<{ name: string }> {
    const config = normalizeServerConfig(payload);
    if (this.servers.has(config.name)) {
      throw new McpServiceError(`MCP Server 已存在: ${config.name}`, 400);
    }
    config.created_at = new Date().toISOString();
    this.servers.set(config.name, config);
    this.saveServersToDisk();
    await this.connectIfAutoEnabled(config.name);
    return { name: config.name };
  }

  async updateServer(serverName: string, payload: McpServerPayload): Promise<McpServerStatus> {
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
    // 连接相关字段(transport/command/args/env/url/headers)变更才断开重连;
    // 仅改 risk_level/tool_risk_overrides/display_name 等非连接字段时保留现有连接(避免无谓重连)。
    const connectionChanged = isConnectionChanged(existing, merged);
    this.servers.set(serverName, merged);
    this.saveServersToDisk();
    if (connectionChanged) {
      this.disconnectServer(serverName);
      await this.connectIfAutoEnabled(serverName);
    } else {
      // 非连接字段变更:刷新已连接 state 的 config,让 risk_level/tool_risk_overrides 等立即生效
      // (state.config 是连接时的快照,不刷新则 getServerStatus/listServerTools/createMcpTools 仍读旧值)。
      const state = this.connections.get(serverName);
      if (state) {
        state.config = cloneServer(merged);
      }
      if (!merged.enabled && existing.enabled) {
        this.disconnectServer(serverName);
      } else if (merged.enabled && merged.auto_connect) {
        const status = this.getServerStatus(serverName).status;
        if (status !== "connected" && status !== "connecting") {
          await this.connectIfAutoEnabled(serverName);
        }
      }
    }
    return this.getServerStatus(serverName);
  }

  deleteServer(serverName: string): void {
    this.disconnectServer(serverName);
    if (!this.servers.delete(serverName)) {
      throw new McpServiceError(`MCP Server 不存在: ${serverName}`, 404);
    }
    // 清理运行时状态(避免同名 server 重建后 metrics 串台 + 内存泄漏)。
    this.connections.delete(serverName);
    this.metrics.delete(serverName);
    this.manuallyDisconnectedServers.delete(serverName);
    this.suppressReconnect.delete(serverName);
    this.saveServersToDisk();
  }

  ensureServer(serverName: string): McpServerConfig {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new McpServiceError(`MCP Server not found: ${serverName}`, 404);
    }
    return server;
  }

  async connectServer(serverName: string, options: { automatic?: boolean } = {}): Promise<McpServerStatus> {
    const server = this.ensureServer(serverName);
    if (!server.enabled) {
      throw new McpServiceError(`MCP Server 已禁用: ${serverName}`, 400);
    }
    if (!options.automatic) {
      this.manuallyDisconnectedServers.delete(serverName);
    } else if (this.manuallyDisconnectedServers.has(serverName)) {
      return this.getServerStatus(serverName);
    }
    const existing = this.connections.get(serverName);
    if (existing?.status === "connected") {
      return this.getServerStatus(serverName);
    }

    const state: McpConnectionState = {
      serverName,
      config: cloneServer(server),
      status: "connecting",
      errorMessage: null,
      tools: [],
      client: null,
      capabilities: undefined,
      resources: [],
      prompts: [],
      reconnectAttempts: existing?.reconnectAttempts ?? 0,
    };
    this.connections.set(serverName, state);

    try {
      const client = new SdkMcpClient(server, () => this.handleDisconnect(serverName), (params) => {
        const prefix = `[MCP:${serverName}]${params.logger ? ` (${params.logger})` : ""} ${params.level}`;
        // error 及以上进 stderr,其余 stdout;data 直接交 console 序列化(util.inspect 能处理循环引用)。
        if (params.level === "error" || params.level === "critical" || params.level === "alert" || params.level === "emergency") {
          console.error(prefix, params.data);
        } else {
          console.log(prefix, params.data);
        }
      });
      await client.connect();
      if (options.automatic && this.manuallyDisconnectedServers.has(serverName)) {
        client.close();
        state.status = "disconnected";
        state.errorMessage = null;
        state.tools = [];
        state.client = null;
        return this.getServerStatus(serverName);
      }
      state.client = client;
      state.tools = client.tools;
      state.capabilities = client.getServerCapabilities();
      state.resources = await client.listResources();
      state.prompts = await client.listPrompts();
      state.status = "connected";
      state.errorMessage = null;
      state.reconnectAttempts = 0;
      return this.getServerStatus(serverName);
    } catch (error) {
      state.status = "error";
      state.errorMessage = formatError(error);
      state.tools = [];
      state.resources = [];
      state.prompts = [];
      state.capabilities = undefined;
      state.client?.close();
      state.client = null;
      if (error instanceof McpServiceError) {
        throw error;
      }
      throw new McpServiceError(state.errorMessage || "MCP server connection failed", 400);
    }
  }

  disconnectServer(serverName: string, options: { manual?: boolean } = {}): void {
    if (options.manual) {
      this.manuallyDisconnectedServers.add(serverName);
    }
    // 主动断开:抑制 onclose 触发的自动重连(onclose 可能同步/异步触发,都检查 suppressReconnect)。
    this.suppressReconnect.add(serverName);
    const state = this.connections.get(serverName);
    if (state?.client) {
      state.client.close();
    }
    if (state) {
      state.status = "disconnected";
      state.errorMessage = null;
      state.tools = [];
      state.resources = [];
      state.prompts = [];
      state.capabilities = undefined;
      state.client = null;
    }
    // 兜底清 suppress(onclose 可能不触发,1s 后强制清)。
    setTimeout(() => this.suppressReconnect.delete(serverName), 1000);
  }

  /** transport 意外断开(client.onclose)时触发:标记 disconnected + auto_connect 时退避重连。 */
  private handleDisconnect(serverName: string): void {
    if (this.suppressReconnect.has(serverName)) {
      this.suppressReconnect.delete(serverName);
      return; // 主动断开(disconnectServer 触发的 onclose),不重连
    }
    const state = this.connections.get(serverName);
    if (!state || state.status === "disconnected") return;
    state.status = "disconnected";
    state.client?.close(); // 显式卸载 notification handler + 关 transport,避免重连后旧 handler 残留(幽灵日志)
    state.client = null;
    state.tools = [];
    state.resources = [];
    state.prompts = [];
    state.capabilities = undefined;
    state.errorMessage = "连接意外断开";
    if (this.manuallyDisconnectedServers.has(serverName)) return;
    const server = this.servers.get(serverName);
    if (!server?.enabled || !server.auto_connect) return;
    this.scheduleReconnect(serverName);
  }

  /** 退避重连:指数退避(1s/2s/4s...),上限 5 次/30s。 */
  private scheduleReconnect(serverName: string): void {
    const state = this.connections.get(serverName);
    if (!state) return;
    if (state.reconnectAttempts >= 5) {
      state.errorMessage = "重连失败(已重试 5 次),请手动重连";
      return;
    }
    state.reconnectAttempts += 1;
    const attempts = state.reconnectAttempts;
    const delay = Math.min(1000 * 2 ** (attempts - 1), 30000);
    setTimeout(() => {
      if (this.manuallyDisconnectedServers.has(serverName)) return;
      const current = this.connections.get(serverName);
      if (current?.status === "connected" || current?.status === "connecting") return;
      this.connectServer(serverName, { automatic: true })
        .catch(() => {
          this.scheduleReconnect(serverName);
        });
    }, delay);
  }

  async testServer(serverName: string): Promise<{ success: boolean; message: string; tool_count: number }> {
    this.disconnectServer(serverName);
    const status = await this.connectServer(serverName);
    return {
      success: status.status === "connected",
      message: status.status === "connected" ? `连接成功，发现 ${status.tool_count} 个工具` : status.error_message ?? "连接失败",
      tool_count: status.tool_count,
    };
  }

  listServerTools(serverName: string): { server_name: string; tool_count: number; tools: RuntimeMcpToolDefinition[] } {
    this.ensureServer(serverName);
    const tools = this.getRuntimeToolsForServer(serverName);
    return {
      server_name: serverName,
      tool_count: tools.length,
      tools,
    };
  }

  listServerResources(serverName: string): { server_name: string; resource_count: number; resources: McpResource[] } {
    this.ensureServer(serverName);
    const state = this.connections.get(serverName);
    const resources = state?.resources ?? [];
    return { server_name: serverName, resource_count: resources.length, resources };
  }

  async readResource(serverName: string, uri: string): Promise<McpResourceContent[]> {
    const state = this.connections.get(serverName);
    if (!state?.client || state.status !== "connected") {
      throw new McpServiceError(`MCP Server '${serverName}' 未连接`, 400);
    }
    return state.client.readResource(uri);
  }

  listServerPrompts(serverName: string): { server_name: string; prompt_count: number; prompts: McpPrompt[] } {
    this.ensureServer(serverName);
    const state = this.connections.get(serverName);
    const prompts = state?.prompts ?? [];
    return { server_name: serverName, prompt_count: prompts.length, prompts };
  }

  async getPrompt(serverName: string, name: string, args?: Record<string, unknown>): Promise<McpPromptMessage[]> {
    const state = this.connections.get(serverName);
    if (!state?.client || state.status !== "connected") {
      throw new McpServiceError(`MCP Server '${serverName}' 未连接`, 400);
    }
    return state.client.getPrompt(name, args);
  }

  listAllTools(): { tool_count: number; tools: RuntimeMcpToolDefinition[] } {
    const tools = Array.from(this.connections.keys()).flatMap((serverName) => this.getRuntimeToolsForServer(serverName));
    return {
      tool_count: tools.length,
      tools,
    };
  }

  /** 聚合所有已连接 server 的 prompts(供命令面板注册动态命令)。 */
  listAllPrompts(): { prompt_count: number; prompts: Array<McpPrompt & { server_name: string }> } {
    const prompts: Array<McpPrompt & { server_name: string }> = [];
    for (const [serverName, state] of this.connections) {
      if (state.status !== "connected") continue;
      for (const prompt of state.prompts ?? []) {
        prompts.push({ ...prompt, server_name: serverName });
      }
    }
    return { prompt_count: prompts.length, prompts };
  }

  listRuntimeTools(enabledServers: string[] = []): RuntimeMcpToolDefinition[] {
    const enabled = new Set(enabledServers.map((server) => server.trim()).filter(Boolean));
    return Array.from(enabled).flatMap((serverName) => this.getRuntimeToolsForServer(serverName));
  }

  async callRuntimeTool(
    fullToolName: string,
    args: Record<string, unknown> | undefined,
    meta?: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const parsed = parseMcpToolName(fullToolName);
    if (!parsed) {
      return toolError(`无效的 MCP 工具名: ${fullToolName}`, fullToolName);
    }
    const [serverName, toolName] = parsed;
    const start = Date.now();
    const result = await this.callTool(serverName, toolName, args ?? {}, meta);
    this.recordMetrics(serverName, toolName, result.success, Date.now() - start);
    return result;
  }

  /** 采集 per-server/per-tool 调用 metrics(次数/成功/失败/延迟)。 */
  private recordMetrics(serverName: string, toolName: string, success: boolean, durationMs: number): void {
    let serverMetrics = this.metrics.get(serverName);
    if (!serverMetrics) {
      serverMetrics = new Map();
      this.metrics.set(serverName, serverMetrics);
    }
    let m = serverMetrics.get(toolName);
    if (!m) {
      m = { tool_name: toolName, calls: 0, successes: 0, failures: 0, total_duration_ms: 0 };
      serverMetrics.set(toolName, m);
    }
    m.calls += 1;
    if (success) m.successes += 1;
    else m.failures += 1;
    m.total_duration_ms += durationMs;
  }

  getServerMetrics(serverName: string): {
    server_name: string;
    tools: McpToolMetrics[];
    resilience: ExternalCallMetrics | null;
  } {
    this.ensureServer(serverName);
    const serverMetrics = this.metrics.get(serverName);
    return {
      server_name: serverName,
      tools: serverMetrics ? [...serverMetrics.values()] : [],
      resilience: externalCallPolicy.snapshot(`mcp:${serverName}`)[0] ?? null,
    };
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const state = this.connections.get(serverName);
    const fullToolName = buildMcpToolName(serverName, toolName);
    if (!state || state.status !== "connected" || !state.client) {
      return toolError(`MCP Server '${serverName}' 未连接`, fullToolName, { server_name: serverName });
    }
    try {
      // MCP tools may have side effects, so the shared policy deliberately performs only one attempt.
      const result = await externalCallPolicy.execute({
        key: `mcp:${serverName}`,
        timeoutMs: Math.max(1, state.config.timeout) * 1000,
        maxAttempts: 1,
        operation: ({ signal }) => state.client!.callTool(toolName, args, meta, signal),
      });
      return normalizeToolResult(fullToolName, serverName, toolName, result);
    } catch (error) {
      return toolError(`MCP 工具调用失败: ${formatError(error)}`, fullToolName, { server_name: serverName });
    }
  }

  getServerStatus(serverName: string): McpServerStatus {
    const state = this.connections.get(serverName);
    if (!state) {
      return defaultStatus();
    }
    return {
      status: state.status,
      tool_count: state.tools.length,
      tools: state.tools.map((tool) => toRuntimeMcpTool(serverName, tool, state.config.risk_level, state.config.tool_risk_overrides, state.config.trusted)),
      error_message: state.errorMessage,
      resource_count: state.resources.length,
      prompt_count: state.prompts.length,
      ...(state.capabilities ? { capability_faces: state.capabilities } : {}),
    };
  }

  close(): void {
    for (const serverName of Array.from(this.connections.keys())) {
      this.disconnectServer(serverName);
    }
    this.connections.clear();
  }

  private async connectIfAutoEnabled(serverName: string): Promise<void> {
    const server = this.servers.get(serverName);
    if (!server?.enabled || !server.auto_connect) {
      return;
    }
    if (this.manuallyDisconnectedServers.has(serverName)) {
      return;
    }
    try {
      await this.connectServer(serverName, { automatic: true });
    } catch {
      // Saving the config should succeed; callers can read the error status.
    }
  }

  private getRuntimeToolsForServer(serverName: string): RuntimeMcpToolDefinition[] {
    const state = this.connections.get(serverName);
    if (!state || state.status !== "connected") {
      return [];
    }
    return state.tools.map((tool) => toRuntimeMcpTool(serverName, tool, state.config.risk_level, state.config.tool_risk_overrides, state.config.trusted));
  }

  private loadServersFromDisk(): void {
    if (!this.configPath || !fs.existsSync(this.configPath)) {
      return;
    }
    const raw = fs.readFileSync(this.configPath, "utf8");
    const parsed = YAML.parse(raw) as unknown;
    const servers = isRecord(parsed) && isRecord(parsed.servers) ? parsed.servers : {};
    this.servers.clear();
    for (const [name, value] of Object.entries(servers)) {
      if (!isRecord(value)) {
        continue;
      }
      try {
        const config = normalizeServerConfig({ ...value, name });
        if (typeof value.created_at === "string") {
          config.created_at = value.created_at;
        }
        if (typeof value.updated_at === "string") {
          config.updated_at = value.updated_at;
        }
        this.servers.set(config.name, config);
      } catch {
        // Skip invalid persisted entries instead of breaking startup.
      }
    }
  }

  private saveServersToDisk(): void {
    if (!this.configPath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const servers = Object.fromEntries(
      Array.from(this.servers.entries()).map(([name, config]) => {
        const entry = cloneServer(config) as Record<string, unknown>;
        delete entry.name;
        return [name, entry];
      }),
    );
    fs.writeFileSync(this.configPath, YAML.stringify({ servers }), "utf8");
  }
}
