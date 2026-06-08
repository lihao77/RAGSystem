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
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface McpServerStatus {
  status: "connected" | "connecting" | "disconnected" | "error" | "unknown" | "not_loaded";
  tool_count: number;
  tools: unknown[];
  error_message: string | null;
}

export type McpServerListItem = McpServerConfig & McpServerStatus;
