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
import type { RiskLevel } from "../../contracts/permissions.js";
import type { ToolExecutionResult, ToolResultMedia } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "../agent/sdk/tool-results.js";

const MCP_TOOL_PREFIX = "mcp__";
const MCP_SERVERS_RELATIVE_PATH = path.join("config", "mcp", "mcp_servers.yaml");
const REGISTRY_BASE_URL = process.env.MCP_REGISTRY_BASE_URL || "https://registry.modelcontextprotocol.io";
const REGISTRY_TIMEOUT_MS = Math.max(1000, Number(process.env.MCP_REGISTRY_TIMEOUT ?? 15) * 1000);
const MAX_REGISTRY_SEARCH_PAGES = 5;

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

class SdkMcpClient implements McpClient {
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

function createMcpTransport(config: McpServerConfig): { transport: Transport; stderr: Stream | null } {
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

interface McpClient {
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

interface McpConnectionState {
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

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

/** MCP 2025 规范的 tool.annotations——server 自声明的行为 hint(SDK 规范明示 hint 不可信源)。 */
interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** MCP logging notification 参数(server → client 的日志消息)。 */
interface McpLogParams {
  level: McpLogLevel;
  logger?: string;
  data: unknown;
}

const MCP_LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const;
type McpLogLevel = typeof MCP_LOG_LEVELS[number];

/** 从 env MCP_LOG_LEVEL 读 logging level(默认 info),非法值回退 info。 */
function normalizeLogLevel(value: string | undefined): McpLogLevel {
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

function normalizeServerConfig(payload: Record<string, unknown>): McpServerConfig {
  const name = String(payload.name ?? "").trim();
  if (!name) {
    throw new McpServiceError("name is required", 400);
  }
  const transport = normalizeTransport(String(payload.transport ?? "stdio"));
  const config: McpServerConfig = {
    name,
    display_name: String(payload.display_name ?? ""),
    transport,
    command: payload.command === undefined ? null : nullableString(payload.command),
    args: Array.isArray(payload.args) ? payload.args.map((item) => String(item)) : [],
    env: stringRecord(payload.env),
    url: payload.url === undefined ? null : nullableString(payload.url),
    headers: stringRecord(payload.headers),
    enabled: typeof payload.enabled === "boolean" ? payload.enabled : true,
    auto_connect: typeof payload.auto_connect === "boolean" ? payload.auto_connect : true,
    timeout: readPositiveInt(payload.timeout, 30),
    risk_level: String(payload.risk_level ?? "medium"),
    tool_risk_overrides: stringRecord(payload.tool_risk_overrides),
    trusted: typeof payload.trusted === "boolean" ? payload.trusted : true,
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

/** 判断两次配置的连接相关字段是否变更(决定是否需要断开重连)。 */
function isConnectionChanged(a: McpServerConfig, b: McpServerConfig): boolean {
  return a.transport !== b.transport
    || a.command !== b.command
    || a.url !== b.url
    || JSON.stringify(a.args) !== JSON.stringify(b.args)
    || JSON.stringify(a.env) !== JSON.stringify(b.env)
    || JSON.stringify(a.headers) !== JSON.stringify(b.headers);
}

function defaultStatus(): McpServerStatus {
  return {
    status: "not_loaded",
    tool_count: 0,
    tools: [],
    error_message: "",
    resource_count: 0,
    prompt_count: 0,
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
    "tool_risk_overrides",
    "trusted",
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

function resolveConfigPath(options: { dataRoot?: string | undefined; configPath?: string | undefined }): string | null {
  if (options.configPath !== undefined) {
    const trimmed = options.configPath.trim();
    return trimmed ? path.resolve(trimmed) : null;
  }
  return path.join(path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem")), MCP_SERVERS_RELATIVE_PATH);
}

function resolveSpawnCommand(command: string, args: string[]): { command: string; args: string[] } {
  // SDK 的 StdioClientTransport 用 cross-spawn(shell:false),能处理 Windows .cmd + 含空格路径,
  // 直接透传 command/args 即可。早期手写 StdioMcpClient 需预解析(把 npx.cmd 拆成 node+npx-cli.js),
  // 但预解析产生的含空格完整路径(如 D:\Program Files\nodejs\node.exe)反被 cross-spawn 按空格分割失败;
  // cross-spawn 接管后预解析多余且有害,直接传 command 让它自行解析 .cmd/PATH。
  return { command, args };
}

function normalizeMcpTools(value: unknown): McpTool[] {
  const tools = isRecord(value) && Array.isArray(value.tools) ? value.tools : [];
  return tools.flatMap((tool): McpTool[] => {
    if (!isRecord(tool)) {
      return [];
    }
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) {
      return [];
    }
    const result: McpTool = {
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
    };
    const annotations = readMcpToolAnnotations(tool.annotations);
    if (annotations) {
      result.annotations = annotations;
    }
    return [result];
  });
}

/** 提取 MCP tool.annotations(只保留已知 hint 字段,忽略其他)。 */
function readMcpToolAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const annotations: McpToolAnnotations = {};
  if (typeof value.title === "string" && value.title.trim()) {
    annotations.title = value.title.trim();
  }
  if (typeof value.readOnlyHint === "boolean") {
    annotations.readOnlyHint = value.readOnlyHint;
  }
  if (typeof value.destructiveHint === "boolean") {
    annotations.destructiveHint = value.destructiveHint;
  }
  if (typeof value.idempotentHint === "boolean") {
    annotations.idempotentHint = value.idempotentHint;
  }
  if (typeof value.openWorldHint === "boolean") {
    annotations.openWorldHint = value.openWorldHint;
  }
  return Object.keys(annotations).length ? annotations : undefined;
}

function normalizePromptArgument(value: unknown): McpPromptArgument {
  const item = isRecord(value) ? value : {};
  const arg: McpPromptArgument = { name: typeof item.name === "string" ? item.name : "" };
  if (typeof item.description === "string") arg.description = item.description;
  if (typeof item.required === "boolean") arg.required = item.required;
  return arg;
}

/** MCP 工具通用自描述(下沉到数据源,SDK Tool 与 HTTP /tools 共用,消除 routes 层重复)。 */
const MCP_TOOL_USAGE_CONTRACT = [
  "先根据 description 和 parameters 判断该 MCP 工具适用场景",
  "返回结构可能不固定,链式传递时优先使用工具返回的 content",
  "若结果是大对象,先读取关键信息再决定是否继续传递给下游工具",
];

const MCP_TOOL_RETURNS = {
  description: "返回结构由 MCP Server 定义,可能因工具而异",
  shape: {
    content: "server_defined",
    metadata: "server_defined",
  },
};

function toRuntimeMcpTool(serverName: string, tool: McpTool, riskLevel: string, toolRiskOverrides?: Record<string, string>, trusted = true): RuntimeMcpToolDefinition {
  const annotations = tool.annotations;
  // 风险优先级:per-tool 覆盖 > server 级 risk_level;annotations 是 hint(SDK 明示不可信),
  // 只往保守方向修正:destructiveHint=true 提升到 high;false 不降级(避免不可信 server 谎报)。
  const overrideRisk = toolRiskOverrides?.[tool.name];
  const baseRisk = overrideRisk ? normalizeRiskLevel(overrideRisk) : normalizeRiskLevel(riskLevel);
  const effectiveRisk: RiskLevel = annotations?.destructiveHint === true && baseRisk !== "high" ? "high" : baseRisk;
  const result: RuntimeMcpToolDefinition = {
    name: buildMcpToolName(serverName, tool.name),
    description: `[MCP:${serverName}] ${tool.description}`.trim(),
    parameters: tool.inputSchema,
    source: "mcp",
    category: "mcp",
    riskLevel: effectiveRisk,
    server_name: serverName,
    original_tool_name: tool.name,
    usage_contract: MCP_TOOL_USAGE_CONTRACT,
    returns: MCP_TOOL_RETURNS,
  };
  // untrusted server 不透传 annotations 给 buildTool(不信 readOnlyHint 驱动并发,保守串行);
  // destructiveHint 提升已在 effectiveRisk 体现(保守方向,untrusted 仍生效)。
  if (trusted && annotations) {
    result.annotations = annotations;
  }
  return result;
}

function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

function parseMcpToolName(toolName: string): [serverName: string, toolName: string] | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) {
    return null;
  }
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator >= rest.length - 2) {
    return null;
  }
  return [rest.slice(0, separator), rest.slice(separator + 2)];
}

function normalizeRiskLevel(value: string): RiskLevel {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function normalizeToolResult(
  fullToolName: string,
  serverName: string,
  toolName: string,
  result: Record<string, unknown>,
): ToolExecutionResult {
  const contentItems = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  const otherContent: unknown[] = [];
  const media: ToolResultMedia[] = [];
  for (const item of contentItems) {
    if (isRecord(item) && item.type === "text") {
      texts.push(String(item.text ?? ""));
    } else if (isRecord(item) && item.type === "image") {
      const image = normalizeMcpImage(item);
      if (image) media.push(image);
      else otherContent.push({ type: "image", error: "unsupported_or_invalid_image" });
    } else {
      otherContent.push(item);
    }
  }
  const text = texts.join("\n");
  if (result.isError === true) {
    return toolError(text || "MCP 工具返回错误", fullToolName, { server_name: serverName });
  }
  const content = otherContent.length ? { text, content: otherContent } : text;
  return toolSuccess(content, {
    toolName: fullToolName,
    summary: `MCP 工具 ${toolName} 执行成功`,
    outputType: otherContent.length ? "json" : "text",
    metadata: { server_name: serverName },
    ...(media.length ? { media } : {}),
  });
}

function normalizeMcpImage(item: Record<string, unknown>): ToolResultMedia | null {
  const mimeType = typeof item.mimeType === "string" ? item.mimeType.toLowerCase() : "";
  if (!isSupportedToolImageMime(mimeType) || typeof item.data !== "string" || !item.data) return null;
  return {
    kind: "image",
    mimeType,
    source: { type: "base64", data: item.data },
    alt: "MCP tool image result",
    detail: "auto",
  };
}

function isSupportedToolImageMime(value: string): value is ToolResultMedia["mimeType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp";
}

function buildServerConfigFromRegistryInstall(payload: McpRegistryInstall): McpServerConfig {
  const installOption = payload.install_option;
  if (!isRecord(installOption)) {
    throw new McpServiceError("`install_option` is required", 400);
  }
  if (installOption.supported === false) {
    throw new McpServiceError(String(installOption.unsupported_reason ?? "Unsupported install option"), 400);
  }
  const kind = String(installOption.kind ?? "").trim();
  const name = cleanServerName(payload.server_name ?? readString(installOption.default_server_name));
  if (!name) {
    throw new McpServiceError("`server_name` is required", 400);
  }
  const base = {
    name,
    display_name: payload.display_name ?? readString(installOption.default_display_name) ?? name,
    enabled: payload.enabled ?? true,
    auto_connect: payload.auto_connect ?? true,
    timeout: typeof payload.timeout === "number" ? payload.timeout : readPositiveInt(installOption.default_timeout, 30),
    risk_level: payload.risk_level ?? readString(installOption.default_risk_level) ?? "medium",
  };
  const inputValues = isRecord(payload.input_values) ? payload.input_values : {};

  if (kind === "package") {
    const recipe = isRecord(installOption.recipe) ? installOption.recipe : {};
    const transport = normalizeTransport(readNestedString(recipe, ["transport", "type"]) ?? "stdio");
    if (transport !== "stdio") {
      throw new McpServiceError(`暂不支持从 Registry 一键安装 transport=${transport} 的本地包`, 400);
    }
    const { command, args } = resolvePackageRuntime(recipe, inputValues);
    return normalizeServerConfig({
      ...base,
      transport: "stdio",
      command,
      args,
      env: resolveKeyValueItems(recipe.environmentVariables, inputValues),
      headers: {},
      url: null,
    });
  }

  if (kind === "remote") {
    const recipe = isRecord(installOption.recipe) ? installOption.recipe : {};
    const transport = normalizeTransport(readString(recipe.type) ?? readString(installOption.transport) ?? "streamable_http");
    if (transport !== "sse" && transport !== "streamable_http") {
      throw new McpServiceError(`不支持的远程 transport: ${transport}`, 400);
    }
    const url = resolveTemplateString(readString(recipe.url) ?? "", inputValues, isRecord(recipe.variables) ? recipe.variables : {});
    if (!url) {
      throw new McpServiceError("Registry 远程服务缺少 URL", 400);
    }
    return normalizeServerConfig({
      ...base,
      transport,
      command: null,
      args: [],
      env: {},
      headers: resolveKeyValueItems(recipe.headers, inputValues),
      url,
    });
  }

  throw new McpServiceError(`未知的安装方式: ${kind || "unknown"}`, 400);
}

function resolvePackageRuntime(recipe: Record<string, unknown>, inputValues: Record<string, unknown>): { command: string; args: string[] } {
  const runtimeHint = readString(recipe.runtimeHint) ?? runtimeForRegistry(readString(recipe.registryType));
  const identifier = readString(recipe.identifier);
  if (!runtimeHint) {
    throw new McpServiceError(`暂不支持自动解析 registryType=${readString(recipe.registryType) ?? "unknown"} 的启动命令`, 400);
  }
  if (!identifier) {
    throw new McpServiceError("Registry package 缺少 identifier", 400);
  }
  const runtimeArgs = resolveArguments(recipe.runtimeArguments, inputValues);
  const packageArgs = resolveArguments(recipe.packageArguments, inputValues);
  const version = readString(recipe.version);

  if (runtimeHint === "npx") {
    const args = runtimeArgs.length ? [...runtimeArgs] : ["-y"];
    args.push(version ? `${identifier}@${version}` : identifier, ...packageArgs);
    return { command: "npx", args };
  }
  if (runtimeHint === "uvx") {
    return { command: "uvx", args: [...runtimeArgs, version ? `${identifier}==${version}` : identifier, ...packageArgs] };
  }
  if (runtimeHint === "docker") {
    const args = runtimeArgs[0] === "run" ? [...runtimeArgs] : ["run", "-i", "--rm", ...runtimeArgs];
    for (const [name, value] of Object.entries(resolveKeyValueItems(recipe.environmentVariables, inputValues))) {
      args.push("-e", `${name}=${value}`);
    }
    args.push(identifier, ...packageArgs);
    return { command: "docker", args };
  }
  if (runtimeHint === "dnx") {
    const args = [...runtimeArgs, identifier];
    if (version) {
      args.push("--version", version);
    }
    args.push(...packageArgs);
    return { command: "dnx", args };
  }
  throw new McpServiceError(`暂不支持 runtimeHint=${runtimeHint}`, 400);
}

function resolveArguments(value: unknown, inputValues: Record<string, unknown>): string[] {
  const items = Array.isArray(value) ? value : [];
  return items.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const resolved = resolveInputValue(item, inputValues);
    if (!resolved) {
      return [];
    }
    const values = item.isRepeated ? resolved.split(",").map((part) => part.trim()).filter(Boolean) : [resolved];
    if (item.type === "named") {
      const name = readString(item.name);
      if (!name) {
        throw new McpServiceError("命名参数缺少 `name`", 400);
      }
      if ((readString(item.format) ?? "string") === "boolean") {
        return parseBoolean(resolved) ? [name] : [];
      }
      return values.flatMap((current) => [name, current]);
    }
    return values;
  });
}

function resolveKeyValueItems(value: unknown, inputValues: Record<string, unknown>): Record<string, string> {
  const items = Array.isArray(value) ? value : [];
  const result: Record<string, string> = {};
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const name = readString(item.name);
    const resolved = resolveInputValue(item, inputValues);
    if (name && resolved) {
      result[name] = resolved;
    }
  }
  return result;
}

function resolveInputValue(item: Record<string, unknown>, inputValues: Record<string, unknown>): string | null {
  if (item.value !== undefined && item.value !== null && item.value !== "") {
    return resolveTemplateString(String(item.value), inputValues, isRecord(item.variables) ? item.variables : {});
  }
  const fieldKey = readString(item.client_field_key);
  if (fieldKey && inputValues[fieldKey] !== undefined && inputValues[fieldKey] !== null && inputValues[fieldKey] !== "") {
    return String(inputValues[fieldKey]);
  }
  if (item.default !== undefined && item.default !== null && item.default !== "") {
    return String(item.default);
  }
  if (item.isRequired) {
    throw new McpServiceError(`请填写 ${readString(item.label) ?? readString(item.name) ?? fieldKey ?? "配置项"}`, 400);
  }
  return null;
}

function resolveTemplateString(template: string, inputValues: Record<string, unknown>, variables: Record<string, unknown>): string {
  let resolved = template;
  for (const [name, variable] of Object.entries(variables)) {
    if (!isRecord(variable)) {
      continue;
    }
    const value = resolveInputValue(variable, inputValues);
    if (value !== null) {
      resolved = resolved.replaceAll(`{${name}}`, value);
    }
  }
  return resolved;
}

function normalizeRegistryEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const server = isRecord(entry.server) ? entry.server : entry;
  const meta = isRecord(entry._meta) && isRecord(entry._meta["io.modelcontextprotocol.registry/official"])
    ? entry._meta["io.modelcontextprotocol.registry/official"] as Record<string, unknown>
    : {};
  const displayName = readString(server.title) ?? readString(server.name) ?? "";
  const installOptions = [
    ...readRecordArray(server.packages).map((item, index) => normalizePackageOption(server, item, index)),
    ...readRecordArray(server.remotes).map((item, index) => normalizeRemoteOption(server, item, index)),
  ];
  const preferred = installOptions.find((option) => option.supported === true)?.id ?? null;
  return {
    name: readString(server.name) ?? "",
    display_name: displayName,
    description: readString(server.description) ?? "",
    version: readString(server.version) ?? "",
    latest: Boolean(meta.isLatest ?? false),
    published_at: readString(meta.publishedAt),
    updated_at: readString(meta.updatedAt),
    website_url: readString(server.websiteUrl),
    repository_url: readNestedString(server, ["repository", "url"]),
    installable: installOptions.some((option) => option.supported === true),
    install_options: installOptions,
    preferred_option_id: preferred,
    default_server_name: cleanServerName(readString(server.name) ?? displayName),
    default_display_name: displayName,
  };
}

async function fetchRegistryPage(search: string, limit: number, cursor: string | null): Promise<unknown> {
  const url = new URL("/v0/servers", REGISTRY_BASE_URL);
  url.searchParams.set("limit", String(limit));
  if (search) {
    url.searchParams.set("search", search);
  }
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  return externalCallPolicy.execute({
    key: "mcp:registry",
    timeoutMs: REGISTRY_TIMEOUT_MS,
    maxAttempts: 3,
    operation: async ({ signal }) => {
      const response = await fetch(url, { signal });
      if (isRetryableHttpStatus(response.status)) {
        throw new RetryableHttpError(response.status, `Failed to query MCP Registry: HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new McpServiceError(`Failed to query MCP Registry: HTTP ${response.status}`, 502);
      }
      return await response.json() as unknown;
    },
  });
}

function readRegistryEntries(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.servers) ? value.servers : [];
}

function normalizePackageOption(server: Record<string, unknown>, source: Record<string, unknown>, index: number): Record<string, unknown> {
  const recipe = annotateRegistryRecipe(structuredClone(source) as Record<string, unknown>, `package.${index}`);
  const transportType = readNestedString(recipe, ["transport", "type"]) ?? "stdio";
  const transport = normalizeTransport(transportType);
  const registryType = readString(recipe.registryType) ?? "custom";
  const runtimeHint = readString(recipe.runtimeHint) ?? runtimeForRegistry(registryType);
  const supported = transport === "stdio" && Boolean(runtimeHint);
  const unsupportedReason = transport !== "stdio"
    ? `当前系统仅支持从 Registry 一键安装 stdio 本地包，暂不支持 ${transportType} 包`
    : runtimeHint
      ? null
      : `当前系统暂不支持 registryType=${registryType} 的自动启动命令`;
  const defaultRiskLevel = runtimeHint === "docker" ? "high" : "medium";
  return {
    id: `pkg-${index}`,
    kind: "package",
    label: `${registryType} · ${transport}`,
    transport,
    runtime_hint: runtimeHint,
    supported,
    unsupported_reason: unsupportedReason,
    command_preview: supported ? buildPackagePreview(recipe) : null,
    url_preview: null,
    form_fields: buildRegistryFormFields(recipe),
    recipe,
    default_server_name: cleanServerName(readString(server.name) ?? ""),
    default_display_name: readString(server.title) ?? readString(server.name) ?? "",
    default_timeout: runtimeHint === "docker" ? 60 : 30,
    default_risk_level: defaultRiskLevel,
  };
}

function normalizeRemoteOption(server: Record<string, unknown>, source: Record<string, unknown>, index: number): Record<string, unknown> {
  const recipe = annotateRegistryRecipe(structuredClone(source) as Record<string, unknown>, `remote.${index}`);
  const transport = normalizeTransport(readString(recipe.type) ?? "streamable-http");
  const supported = transport === "sse" || transport === "streamable_http";
  return {
    id: `remote-${index}`,
    kind: "remote",
    label: `remote · ${transport}`,
    transport,
    runtime_hint: null,
    supported,
    unsupported_reason: supported ? null : `当前系统暂不支持 transport=${transport} 的远程服务`,
    command_preview: null,
    url_preview: buildRemotePreview(recipe),
    form_fields: buildRegistryFormFields(recipe),
    recipe,
    default_server_name: cleanServerName(readString(server.name) ?? ""),
    default_display_name: readString(server.title) ?? readString(server.name) ?? "",
    default_timeout: 60,
    default_risk_level: "medium",
  };
}

function annotateRegistryRecipe(recipe: Record<string, unknown>, prefix: string): Record<string, unknown> {
  for (const [key, source] of [
    ["environmentVariables", "env"],
    ["runtimeArguments", "runtime"],
    ["packageArguments", "package"],
    ["headers", "header"],
  ] as const) {
    readRecordArray(recipe[key]).forEach((item, index) => annotateRegistryInput(item, `${prefix}.${source}.${index}`));
  }
  const variables = isRecord(recipe.variables) ? recipe.variables : {};
  for (const [name, value] of Object.entries(variables)) {
    if (isRecord(value)) {
      annotateRegistryInput(value, `${prefix}.var.${name}`);
    }
  }
  const transport = isRecord(recipe.transport) ? recipe.transport : null;
  if (transport) {
    readRecordArray(transport.headers).forEach((item, index) => annotateRegistryInput(item, `${prefix}.transport_header.${index}`));
    const transportVariables = isRecord(transport.variables) ? transport.variables : {};
    for (const [name, value] of Object.entries(transportVariables)) {
      if (isRecord(value)) {
        annotateRegistryInput(value, `${prefix}.transport_var.${name}`);
      }
    }
  }
  return recipe;
}

function annotateRegistryInput(item: Record<string, unknown>, fieldKey: string): void {
  item.client_field_key = fieldKey;
  const variables = isRecord(item.variables) ? item.variables : {};
  for (const [name, value] of Object.entries(variables)) {
    if (isRecord(value)) {
      annotateRegistryInput(value, `${fieldKey}.var.${name}`);
    }
  }
}

function buildRegistryFormFields(recipe: Record<string, unknown>): Array<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  fields.push(...collectRegistryFields(readRecordArray(recipe.environmentVariables), "env"));
  fields.push(...collectRegistryFields(readRecordArray(recipe.runtimeArguments), "runtime_argument"));
  fields.push(...collectRegistryFields(readRecordArray(recipe.packageArguments), "package_argument"));
  fields.push(...collectRegistryFields(readRecordArray(recipe.headers), "header"));
  const variables = isRecord(recipe.variables) ? recipe.variables : {};
  for (const [name, value] of Object.entries(variables)) {
    if (isRecord(value)) {
      fields.push(...collectSingleRegistryField(value, "variable", name));
    }
  }
  const transport = isRecord(recipe.transport) ? recipe.transport : null;
  if (transport) {
    fields.push(...collectRegistryFields(readRecordArray(transport.headers), "header"));
    const transportVariables = isRecord(transport.variables) ? transport.variables : {};
    for (const [name, value] of Object.entries(transportVariables)) {
      if (isRecord(value)) {
        fields.push(...collectSingleRegistryField(value, "variable", name));
      }
    }
  }
  return fields;
}

function collectRegistryFields(items: Record<string, unknown>[], source: string): Array<Record<string, unknown>> {
  return items.flatMap((item) => collectSingleRegistryField(item, source));
}

function collectSingleRegistryField(item: Record<string, unknown>, source: string, fallbackLabel = "配置项"): Array<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  if (item.value === undefined || item.value === null || item.value === "") {
    const fieldKey = readString(item.client_field_key);
    if (fieldKey) {
      const format = readString(item.format) ?? "string";
      fields.push({
        key: fieldKey,
        label: readString(item.label) ?? readString(item.name) ?? readString(item.valueHint) ?? fallbackLabel,
        description: readString(item.description) ?? "",
        source,
        format,
        required: Boolean(item.isRequired ?? false),
        secret: Boolean(item.isSecret ?? false),
        repeated: Boolean(item.isRepeated ?? false),
        default_value: coerceRegistryDefaultValue(item.default, format),
        placeholder: readString(item.placeholder) ?? "",
      });
    }
  }
  const variables = isRecord(item.variables) ? item.variables : {};
  for (const [name, value] of Object.entries(variables)) {
    if (isRecord(value)) {
      fields.push(...collectSingleRegistryField(value, source, name));
    }
  }
  return fields;
}

function coerceRegistryDefaultValue(value: unknown, format: string): unknown {
  if (value === undefined || value === null || value === "") {
    return format === "boolean" ? false : null;
  }
  if (format === "boolean") {
    return parseBoolean(value);
  }
  if (format === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  return value;
}

function buildPackagePreview(recipe: Record<string, unknown>): string | null {
  try {
    const { command, args } = resolvePackageRuntime(recipe, {});
    return [command, ...args].join(" ").trim();
  } catch {
    return null;
  }
}

function buildRemotePreview(recipe: Record<string, unknown>): string | null {
  try {
    return resolveTemplateString(readString(recipe.url) ?? "", {}, isRecord(recipe.variables) ? recipe.variables : {});
  } catch {
    return readString(recipe.url);
  }
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function runtimeForRegistry(value: string | null): string | null {
  if (value === "npm") {
    return "npx";
  }
  if (value === "pypi") {
    return "uvx";
  }
  if (value === "oci") {
    return "docker";
  }
  if (value === "nuget") {
    return "dnx";
  }
  return null;
}

function normalizeTransport(value: string): "stdio" | "sse" | "streamable_http" {
  const normalized = value.trim().toLowerCase().replace("-", "_");
  if (normalized === "streamablehttp") {
    return "streamable_http";
  }
  if (normalized === "sse" || normalized === "streamable_http") {
    return normalized;
  }
  return "stdio";
}

function cleanServerName(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function parseBoolean(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNestedString(value: unknown, pathParts: string[]): string | null {
  let current = value;
  for (const part of pathParts) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[part];
  }
  return readString(current);
}

function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
