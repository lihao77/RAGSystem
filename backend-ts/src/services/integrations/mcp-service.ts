import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import type {
  McpRegistryInstall,
  McpServerConfig,
  McpServerCreate,
  McpServerListItem,
  McpServerPayload,
  McpServerStatus,
} from "../../contracts/mcp.js";
import type { RiskLevel } from "../../contracts/permissions.js";
import type { ToolExecutionResult } from "../tools/memory-tool-service.js";

const MCP_TOOL_PREFIX = "mcp__";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_SERVERS_RELATIVE_PATH = path.join("config", "mcp", "mcp_servers.yaml");
const REGISTRY_BASE_URL = process.env.MCP_REGISTRY_BASE_URL || "https://registry.modelcontextprotocol.io";
const REGISTRY_TIMEOUT_MS = Math.max(1000, Number(process.env.MCP_REGISTRY_TIMEOUT ?? 15) * 1000);

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
    const url = new URL("/v0/servers", REGISTRY_BASE_URL);
    url.searchParams.set("limit", String(limit));
    if (search) {
      url.searchParams.set("search", search);
    }
    if (input.cursor?.trim()) {
      url.searchParams.set("cursor", input.cursor.trim());
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new McpServiceError(`Failed to query MCP Registry: HTTP ${response.status}`, 502);
      }
      const body = await response.json() as unknown;
      const items = normalizeRegistryItems(body, latestOnly, limit);
      return {
        items,
        count: items.length,
        next_cursor: readNestedString(body, ["metadata", "nextCursor"]),
        search,
        latest_only: latestOnly,
      };
    } catch (error) {
      if (error instanceof McpServiceError) {
        throw error;
      }
      throw new McpServiceError(`Failed to query MCP Registry: ${formatError(error)}`, 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  installServerFromRegistry(payload: McpRegistryInstall): { name: string; status: McpServerStatus["status"] } & McpServerConfig {
    const config = buildServerConfigFromRegistryInstall(payload);
    if (this.servers.has(config.name)) {
      throw new McpServiceError(`MCP Server 已存在: ${config.name}`, 400);
    }
    config.created_at = new Date().toISOString();
    this.servers.set(config.name, config);
    this.saveServersToDisk();
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

  addServer(payload: McpServerCreate): { name: string } {
    const config = normalizeServerConfig(payload);
    if (this.servers.has(config.name)) {
      throw new McpServiceError(`MCP Server 已存在: ${config.name}`, 400);
    }
    config.created_at = new Date().toISOString();
    this.servers.set(config.name, config);
    this.saveServersToDisk();
    return { name: config.name };
  }

  updateServer(serverName: string, payload: McpServerPayload): McpServerStatus {
    const existing = this.servers.get(serverName);
    if (!existing) {
      throw new McpServiceError(`MCP Server not found: ${serverName}`, 404);
    }
    this.disconnectServer(serverName);
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
    this.saveServersToDisk();
    return this.getServerStatus(serverName);
  }

  deleteServer(serverName: string): void {
    this.disconnectServer(serverName);
    if (!this.servers.delete(serverName)) {
      throw new McpServiceError(`MCP Server 不存在: ${serverName}`, 404);
    }
    this.saveServersToDisk();
  }

  ensureServer(serverName: string): McpServerConfig {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new McpServiceError(`MCP Server not found: ${serverName}`, 404);
    }
    return server;
  }

  async connectServer(serverName: string): Promise<McpServerStatus> {
    const server = this.ensureServer(serverName);
    if (!server.enabled) {
      throw new McpServiceError(`MCP Server 已禁用: ${serverName}`, 400);
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
    };
    this.connections.set(serverName, state);

    try {
      if (server.transport !== "stdio") {
        throw new McpServiceError(`${server.transport} MCP transport requires a server reachable through the stdio-compatible runtime adapter`, 400);
      }
      const client = new StdioMcpClient(server);
      await client.connect();
      state.client = client;
      state.tools = client.tools;
      state.status = "connected";
      state.errorMessage = null;
      return this.getServerStatus(serverName);
    } catch (error) {
      state.status = "error";
      state.errorMessage = formatError(error);
      state.tools = [];
      state.client?.close();
      state.client = null;
      if (error instanceof McpServiceError) {
        throw error;
      }
      throw new McpServiceError(state.errorMessage || "MCP server connection failed", 400);
    }
  }

  disconnectServer(serverName: string): void {
    const state = this.connections.get(serverName);
    if (state?.client) {
      state.client.close();
    }
    if (state) {
      state.status = "disconnected";
      state.errorMessage = null;
      state.tools = [];
      state.client = null;
    }
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

  listAllTools(): { tool_count: number; tools: RuntimeMcpToolDefinition[] } {
    const tools = Array.from(this.connections.keys()).flatMap((serverName) => this.getRuntimeToolsForServer(serverName));
    return {
      tool_count: tools.length,
      tools,
    };
  }

  listRuntimeTools(enabledServers: string[] = []): RuntimeMcpToolDefinition[] {
    const enabled = new Set(enabledServers.map((server) => server.trim()).filter(Boolean));
    return Array.from(enabled).flatMap((serverName) => this.getRuntimeToolsForServer(serverName));
  }

  async callRuntimeTool(
    fullToolName: string,
    args: Record<string, unknown> | undefined,
  ): Promise<ToolExecutionResult> {
    const parsed = parseMcpToolName(fullToolName);
    if (!parsed) {
      return toolError(`无效的 MCP 工具名: ${fullToolName}`, fullToolName);
    }
    const [serverName, toolName] = parsed;
    return this.callTool(serverName, toolName, args ?? {});
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const state = this.connections.get(serverName);
    const fullToolName = buildMcpToolName(serverName, toolName);
    if (!state || state.status !== "connected" || !state.client) {
      return toolError(`MCP Server '${serverName}' 未连接`, fullToolName, { server_name: serverName });
    }
    try {
      const result = await state.client.callTool(toolName, args);
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
      tools: state.tools.map((tool) => toRuntimeMcpTool(serverName, tool, state.config.risk_level)),
      error_message: state.errorMessage,
    };
  }

  close(): void {
    for (const serverName of Array.from(this.connections.keys())) {
      this.disconnectServer(serverName);
    }
    this.connections.clear();
  }

  private getRuntimeToolsForServer(serverName: string): RuntimeMcpToolDefinition[] {
    const state = this.connections.get(serverName);
    if (!state || state.status !== "connected") {
      return [];
    }
    return state.tools.map((tool) => toRuntimeMcpTool(serverName, tool, state.config.risk_level));
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

class StdioMcpClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private requestId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private stderr = "";
  tools: McpTool[] = [];

  constructor(private readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    const command = this.config.command?.trim();
    if (!command) {
      throw new Error("stdio 模式需要 command 配置");
    }
    this.process = spawn(command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.process.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
      if (this.stderr.length > 4000) {
        this.stderr = this.stderr.slice(-4000);
      }
    });
    this.process.on("exit", (code, signal) => {
      const message = `MCP stdio process exited: code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.rejectAll(new Error(this.stderr.trim() ? `${message}: ${this.stderr.trim()}` : message));
    });
    this.process.on("error", (error) => {
      this.rejectAll(error);
    });

    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "@ragsystem/backend-ts",
        version: "0.1.0",
      },
    });
    this.notify("notifications/initialized", {});
    const listed = await this.request("tools/list", {});
    this.tools = normalizeMcpTools(listed);
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.request("tools/call", {
      name: toolName,
      arguments: args,
    });
    return isRecord(result) ? result : {};
  }

  close(): void {
    this.rejectAll(new Error("MCP connection closed"));
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const proc = this.process;
    if (!proc?.stdin.writable) {
      return Promise.reject(new Error("MCP stdio process is not writable"));
    }
    const id = this.requestId;
    this.requestId += 1;
    const timeoutMs = Math.max(1, this.config.timeout) * 1000;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          pending.reject(error);
        }
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const proc = this.process;
    if (!proc?.stdin.writable) {
      return;
    }
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.buffer.search(/\r?\n/);
      if (newline < 0) {
        break;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + (this.buffer[newline] === "\r" && this.buffer[newline + 1] === "\n" ? 2 : 1));
      if (!line) {
        continue;
      }
      this.handleMessageLine(line);
    }
  }

  private handleMessageLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (isRecord(message.error)) {
      pending.reject(new Error(String(message.error.message ?? JSON.stringify(message.error))));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

interface McpConnectionState {
  serverName: string;
  config: McpServerConfig;
  status: McpServerStatus["status"];
  errorMessage: string | null;
  tools: McpTool[];
  client: StdioMcpClient | null;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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

function defaultStatus(): McpServerStatus {
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

function resolveConfigPath(options: { dataRoot?: string | undefined; configPath?: string | undefined }): string | null {
  if (options.configPath !== undefined) {
    const trimmed = options.configPath.trim();
    return trimmed ? path.resolve(trimmed) : null;
  }
  return path.join(path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem")), MCP_SERVERS_RELATIVE_PATH);
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
    return [{
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
    }];
  });
}

function toRuntimeMcpTool(serverName: string, tool: McpTool, riskLevel: string): RuntimeMcpToolDefinition {
  return {
    name: buildMcpToolName(serverName, tool.name),
    description: `[MCP:${serverName}] ${tool.description}`.trim(),
    parameters: tool.inputSchema,
    source: "mcp",
    category: "mcp",
    riskLevel: normalizeRiskLevel(riskLevel),
    server_name: serverName,
    original_tool_name: tool.name,
  };
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
  for (const item of contentItems) {
    if (isRecord(item) && item.type === "text") {
      texts.push(String(item.text ?? ""));
    } else {
      otherContent.push(item);
    }
  }
  const text = texts.join("\n");
  if (result.isError === true) {
    return toolError(text || "MCP 工具返回错误", fullToolName, { server_name: serverName });
  }
  const content = otherContent.length ? { text, content: otherContent } : text;
  return {
    success: true,
    tool_name: fullToolName,
    summary: `MCP 工具 ${toolName} 执行成功`,
    answer: null,
    output_type: otherContent.length ? "json" : "text",
    content,
    metadata: { server_name: serverName },
    artifacts: [],
    llm_hint: null,
  };
}

function toolError(message: string, toolName: string, metadata: Record<string, unknown> = {}): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
      ...metadata,
    },
    artifacts: [],
    llm_hint: null,
  };
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

function normalizeRegistryItems(value: unknown, latestOnly: boolean, limit: number): unknown[] {
  const entries = isRecord(value) && Array.isArray(value.servers) ? value.servers : [];
  const items: unknown[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const normalized = normalizeRegistryEntry(entry);
    if (latestOnly && normalized.latest === false) {
      continue;
    }
    items.push(normalized);
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

function normalizeRegistryEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const server = isRecord(entry.server) ? entry.server : entry;
  const meta = isRecord(entry._meta) && isRecord(entry._meta["io.modelcontextprotocol.registry/official"])
    ? entry._meta["io.modelcontextprotocol.registry/official"] as Record<string, unknown>
    : {};
  const displayName = readString(server.title) ?? readString(server.name) ?? "";
  return {
    name: readString(server.name) ?? "",
    display_name: displayName,
    description: readString(server.description) ?? "",
    version: readString(server.version) ?? "",
    latest: Boolean(meta.isLatest ?? true),
    published_at: readString(meta.publishedAt),
    updated_at: readString(meta.updatedAt),
    website_url: readString(server.websiteUrl),
    repository_url: readNestedString(server, ["repository", "url"]),
    installable: Array.isArray(server.packages) || Array.isArray(server.remotes),
    install_options: [],
    preferred_option_id: null,
    default_server_name: cleanServerName(readString(server.name) ?? displayName),
    default_display_name: displayName,
  };
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
