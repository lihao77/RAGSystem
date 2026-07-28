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
import {
  REGISTRY_BASE_URL,
  REGISTRY_TIMEOUT_MS,
  McpServiceError,
} from "./mcp-service.js";
import { normalizeServerConfig } from "./config-normalization.js";


export function buildServerConfigFromRegistryInstall(payload: McpRegistryInstall): McpServerConfig {
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

export function resolvePackageRuntime(recipe: Record<string, unknown>, inputValues: Record<string, unknown>): { command: string; args: string[] } {
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

export function resolveArguments(value: unknown, inputValues: Record<string, unknown>): string[] {
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

export function resolveKeyValueItems(value: unknown, inputValues: Record<string, unknown>): Record<string, string> {
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

export function resolveInputValue(item: Record<string, unknown>, inputValues: Record<string, unknown>): string | null {
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

export function resolveTemplateString(template: string, inputValues: Record<string, unknown>, variables: Record<string, unknown>): string {
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

export function normalizeRegistryEntry(entry: Record<string, unknown>): Record<string, unknown> {
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

export async function fetchRegistryPage(search: string, limit: number, cursor: string | null): Promise<unknown> {
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

export function readRegistryEntries(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.servers) ? value.servers : [];
}

export function normalizePackageOption(server: Record<string, unknown>, source: Record<string, unknown>, index: number): Record<string, unknown> {
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

export function normalizeRemoteOption(server: Record<string, unknown>, source: Record<string, unknown>, index: number): Record<string, unknown> {
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

export function annotateRegistryRecipe(recipe: Record<string, unknown>, prefix: string): Record<string, unknown> {
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

export function annotateRegistryInput(item: Record<string, unknown>, fieldKey: string): void {
  item.client_field_key = fieldKey;
  const variables = isRecord(item.variables) ? item.variables : {};
  for (const [name, value] of Object.entries(variables)) {
    if (isRecord(value)) {
      annotateRegistryInput(value, `${fieldKey}.var.${name}`);
    }
  }
}

export function buildRegistryFormFields(recipe: Record<string, unknown>): Array<Record<string, unknown>> {
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

export function collectRegistryFields(items: Record<string, unknown>[], source: string): Array<Record<string, unknown>> {
  return items.flatMap((item) => collectSingleRegistryField(item, source));
}

export function collectSingleRegistryField(item: Record<string, unknown>, source: string, fallbackLabel = "配置项"): Array<Record<string, unknown>> {
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

export function coerceRegistryDefaultValue(value: unknown, format: string): unknown {
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

export function buildPackagePreview(recipe: Record<string, unknown>): string | null {
  try {
    const { command, args } = resolvePackageRuntime(recipe, {});
    return [command, ...args].join(" ").trim();
  } catch {
    return null;
  }
}

export function buildRemotePreview(recipe: Record<string, unknown>): string | null {
  try {
    return resolveTemplateString(readString(recipe.url) ?? "", {}, isRecord(recipe.variables) ? recipe.variables : {});
  } catch {
    return readString(recipe.url);
  }
}

export function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function runtimeForRegistry(value: string | null): string | null {
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

export function normalizeTransport(value: string): "stdio" | "sse" | "streamable_http" {
  const normalized = value.trim().toLowerCase().replace("-", "_");
  if (normalized === "streamablehttp") {
    return "streamable_http";
  }
  if (normalized === "sse" || normalized === "streamable_http") {
    return normalized;
  }
  return "stdio";
}

export function cleanServerName(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function parseBoolean(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readNestedString(value: unknown, pathParts: string[]): string | null {
  let current = value;
  for (const part of pathParts) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[part];
  }
  return readString(current);
}

export function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}
