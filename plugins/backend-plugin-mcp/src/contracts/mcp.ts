import { z } from "zod";

export const McpTransportSchema = z.enum(["stdio", "sse", "streamable_http"]);

export const McpServerPayloadSchema = z
  .object({
    name: z.string().min(1).optional(),
    display_name: z.string().optional().default(""),
    transport: McpTransportSchema.optional().default("stdio"),
    command: z.string().nullable().optional(),
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string()).optional().default({}),
    url: z.string().nullable().optional(),
    headers: z.record(z.string()).optional().default({}),
    enabled: z.boolean().optional().default(true),
    auto_connect: z.boolean().optional().default(true),
    timeout: z.number().int().min(1).max(300).optional().default(30),
    risk_level: z.string().optional().default("medium"),
    tool_risk_overrides: z.record(z.string()).optional().default({}),
    trusted: z.boolean().optional().default(true),
  })
  .catchall(z.unknown());

export const McpServerCreateSchema = McpServerPayloadSchema.extend({
  name: z.string().min(1),
});

export const McpRegistryInstallSchema = z
  .object({
    install_option: z.unknown().optional(),
    server_name: z.string().optional(),
    display_name: z.string().optional(),
    enabled: z.boolean().optional(),
    auto_connect: z.boolean().optional(),
    timeout: z.number().optional(),
    risk_level: z.string().optional(),
    input_values: z.record(z.unknown()).optional(),
  })
  .catchall(z.unknown());

export type McpTransport = z.infer<typeof McpTransportSchema>;
export type McpServerPayload = z.infer<typeof McpServerPayloadSchema>;
export type McpServerCreate = z.infer<typeof McpServerCreateSchema>;
export type McpRegistryInstall = z.infer<typeof McpRegistryInstallSchema>;

export interface McpServerConfig {
  name: string;
  display_name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  auto_connect: boolean;
  timeout: number;
  risk_level: string;
  tool_risk_overrides: Record<string, string>;
  trusted: boolean;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface McpServerStatus {
  status: "connected" | "connecting" | "disconnected" | "error" | "unknown" | "not_loaded";
  tool_count: number;
  tools: unknown[];
  error_message: string | null;
  resource_count: number;
  prompt_count: number;
  capability_faces?: McpCapabilityFaces;
}

/** MCP server 声明的能力面(getServerCapabilities 探测)。 */
export interface McpCapabilityFaces {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  logging?: boolean;
}

/** MCP resource(只读资源,如文件/数据)。 */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

/** MCP resource 读取内容(text 或 base64 blob)。 */
export interface McpResourceContent {
  uri: string;
  text?: string;
  blob?: string;
}

/** MCP prompt(参数化提示模板)。 */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** MCP prompt 解析后的消息序列。 */
export interface McpPromptMessage {
  role: string;
  content: unknown;
}

/** per-tool 调用 metrics(运行时累积,不持久化)。 */
export interface McpToolMetrics {
  tool_name: string;
  calls: number;
  successes: number;
  failures: number;
  total_duration_ms: number;
}

export type McpServerListItem = McpServerConfig & McpServerStatus;
