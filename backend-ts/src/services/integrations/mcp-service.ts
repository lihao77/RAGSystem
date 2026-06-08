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
    await this.connectIfAutoEnabled(serverName);
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
    };
    this.connections.set(serverName, state);

    try {
      if (server.transport !== "stdio") {
        throw new McpServiceError(`${server.transport} MCP transport requires a server reachable through the stdio-compatible runtime adapter`, 400);
      }
      const client = new StdioMcpClient(server);
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

  disconnectServer(serverName: string, options: { manual?: boolean } = {}): void {
    if (options.manual) {
      this.manuallyDisconnectedServers.add(serverName);
    }
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
    const resolvedCommand = resolveSpawnCommand(command, this.config.args);
    this.process = spawn(resolvedCommand.command, resolvedCommand.args, {
      ...resolvedCommand.options,
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
    status: "not_loaded",
    tool_count: 0,
    tools: [],
    error_message: "",
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

function resolveSpawnCommand(command: string, args: string[]): { command: string; args: string[]; options: { shell?: boolean } } {
  if (process.platform !== "win32" || path.isAbsolute(command)) {
    return { command, args, options: {} };
  }
  const found = findWindowsCommand(command);
  if (found) {
    const npmShim = resolveNpmCmdShim(found);
    if (npmShim) {
      return { command: npmShim.command, args: [...npmShim.args, ...args], options: {} };
    }
    const extension = path.extname(found).toLowerCase();
    if (extension === ".cmd" || extension === ".bat") {
      return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${found}" ${args.map(quoteCmdArg).join(" ")}`], options: {} };
    }
    return { command: found, args, options: {} };
  }
  return { command, args, options: { shell: true } };
}

function findWindowsCommand(command: string): string | null {
  const pathEntries = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const extensions = String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const preferredExtensions = [".CMD", ".EXE", ".BAT", ".COM"];
  const candidates = path.extname(command)
    ? [command]
    : [
        ...preferredExtensions.map((extension) => `${command}${extension.toLowerCase()}`),
        ...preferredExtensions.map((extension) => `${command}${extension.toUpperCase()}`),
        ...extensions.map((extension) => `${command}${extension.toLowerCase()}`),
        ...extensions.map((extension) => `${command}${extension.toUpperCase()}`),
        command,
      ];
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = path.join(entry, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function resolveNpmCmdShim(commandPath: string): { command: string; args: string[] } | null {
  if (path.extname(commandPath).toLowerCase() !== ".cmd") {
    return null;
  }
  const baseDir = path.dirname(commandPath);
  const packageMatch = fs.readFileSync(commandPath, "utf8").match(/node_modules\\([^"\r\n]+?\\bin\\[^"\r\n]+?\.js)/i);
  if (!packageMatch?.[1]) {
    return null;
  }
  const nodePath = path.join(baseDir, "node.exe");
  return {
    command: fs.existsSync(nodePath) ? nodePath : "node",
    args: [path.join(baseDir, "node_modules", packageMatch[1])],
  };
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new McpServiceError(`Failed to query MCP Registry: HTTP ${response.status}`, 502);
    }
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
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
