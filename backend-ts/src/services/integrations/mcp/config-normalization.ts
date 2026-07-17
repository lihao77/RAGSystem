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
} from "../../../contracts/mcp.js";
import type { RiskLevel } from "../../../contracts/permissions.js";
import type { ToolExecutionResult, ToolResultMedia } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "../../agent/sdk/tool-results.js";
import {
  MCP_TOOL_PREFIX,
  MCP_SERVERS_RELATIVE_PATH,
  McpServiceError,
} from "./mcp-service.js";
import {
  McpTool,
  McpToolAnnotations,
  RuntimeMcpToolDefinition,
} from "./transport.js";
import { normalizeTransport, readPositiveInt } from "./registry.js";


export function normalizeServerConfig(payload: Record<string, unknown>): McpServerConfig {
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
export function isConnectionChanged(a: McpServerConfig, b: McpServerConfig): boolean {
  return a.transport !== b.transport
    || a.command !== b.command
    || a.url !== b.url
    || JSON.stringify(a.args) !== JSON.stringify(b.args)
    || JSON.stringify(a.env) !== JSON.stringify(b.env)
    || JSON.stringify(a.headers) !== JSON.stringify(b.headers);
}

export function defaultStatus(): McpServerStatus {
  return {
    status: "not_loaded",
    tool_count: 0,
    tools: [],
    error_message: "",
    resource_count: 0,
    prompt_count: 0,
  };
}

export function nullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return String(value ?? "");
}

export function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([key, current]) => [key, String(current ?? "")]));
}

export function copyExtraFields(config: McpServerConfig, payload: Record<string, unknown>): void {
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

export function cloneServer(server: McpServerConfig): McpServerConfig {
  return structuredClone(server) as McpServerConfig;
}

export function resolveConfigPath(options: { dataRoot?: string | undefined; configPath?: string | undefined }): string | null {
  if (options.configPath !== undefined) {
    const trimmed = options.configPath.trim();
    return trimmed ? path.resolve(trimmed) : null;
  }
  return path.join(path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem")), MCP_SERVERS_RELATIVE_PATH);
}

export function resolveSpawnCommand(command: string, args: string[]): { command: string; args: string[] } {
  // SDK 的 StdioClientTransport 用 cross-spawn(shell:false),能处理 Windows .cmd + 含空格路径,
  // 直接透传 command/args 即可。早期手写 StdioMcpClient 需预解析(把 npx.cmd 拆成 node+npx-cli.js),
  // 但预解析产生的含空格完整路径(如 D:\Program Files\nodejs\node.exe)反被 cross-spawn 按空格分割失败;
  // cross-spawn 接管后预解析多余且有害,直接传 command 让它自行解析 .cmd/PATH。
  return { command, args };
}

export function normalizeMcpTools(value: unknown): McpTool[] {
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
export function readMcpToolAnnotations(value: unknown): McpToolAnnotations | undefined {
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

export function normalizePromptArgument(value: unknown): McpPromptArgument {
  const item = isRecord(value) ? value : {};
  const arg: McpPromptArgument = { name: typeof item.name === "string" ? item.name : "" };
  if (typeof item.description === "string") arg.description = item.description;
  if (typeof item.required === "boolean") arg.required = item.required;
  return arg;
}

/** MCP 工具通用自描述(下沉到数据源,SDK Tool 与 HTTP /tools 共用,消除 routes 层重复)。 */
export const MCP_TOOL_USAGE_CONTRACT = [
  "先根据 description 和 parameters 判断该 MCP 工具适用场景",
  "返回结构可能不固定,链式传递时优先使用工具返回的 content",
  "若结果是大对象,先读取关键信息再决定是否继续传递给下游工具",
];

export const MCP_TOOL_RETURNS = {
  description: "返回结构由 MCP Server 定义,可能因工具而异",
  shape: {
    content: "server_defined",
    metadata: "server_defined",
  },
};

export function toRuntimeMcpTool(serverName: string, tool: McpTool, riskLevel: string, toolRiskOverrides?: Record<string, string>, trusted = true): RuntimeMcpToolDefinition {
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

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

export function parseMcpToolName(toolName: string): [serverName: string, toolName: string] | null {
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

export function normalizeRiskLevel(value: string): RiskLevel {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

export function normalizeToolResult(
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

export function normalizeMcpImage(item: Record<string, unknown>): ToolResultMedia | null {
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

export function isSupportedToolImageMime(value: string): value is ToolResultMedia["mimeType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp";
}
