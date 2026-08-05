import type { SystemConfigExtension } from "@ragsystem/backend-core/contracts/runtime/system-config.js";
import type { SystemConfigValue } from "@ragsystem/backend-core/contracts/runtime/system-config.js";

export interface DocumentExtractionConfig {
  engine: "builtin" | "cli" | "http";
  cli: { command: string; timeout: number; applies_to: string[] };
  http: { endpoint: string; timeout: number; applies_to: string[] };
}

export const KNOWLEDGE_SYSTEM_CONFIG_EXTENSION: SystemConfigExtension = {
  defaults: {
    document_extraction: {
      engine: "builtin",
      cli: { command: "", timeout: 120, applies_to: [] },
      http: { endpoint: "", timeout: 120, applies_to: [] },
    },
  },
  groups: [
    {
      key: "document_extraction",
      label: "文档解析",
      description: "知识库文档文本解析配置",
      fields: [
        {
          key: "engine",
          label: "Engine",
          type: "select",
          default: "builtin",
          help: "解析引擎",
          options: [
            { value: "builtin", label: "builtin" },
            { value: "cli", label: "cli" },
            { value: "http", label: "http" },
          ],
        },
      ],
    },
    {
      key: "document_extraction.cli",
      label: "CLI 文档解析",
      description: "通过本地命令解析文档",
      fields: [
        {
          key: "command",
          label: "Command",
          type: "text",
          default: "",
          help: "命令模板，支持 {input}/{output}；MinerU 示例：mineru -p {input} -o {output}",
        },
        {
          key: "timeout",
          label: "Timeout",
          type: "number",
          default: 120,
          help: "命令超时（秒）",
          min: 1,
          step: 1,
        },
        {
          key: "applies_to",
          label: "Applies To",
          type: "string_list",
          default: [],
          help: "适用类型，逗号分隔；留空表示全部",
        },
      ],
    },
    {
      key: "document_extraction.http",
      label: "HTTP 文档解析",
      description: "通过 HTTP multipart 服务解析文档",
      fields: [
        {
          key: "endpoint",
          label: "Endpoint",
          type: "text",
          default: "",
          help: "文档解析服务地址",
        },
        {
          key: "timeout",
          label: "Timeout",
          type: "number",
          default: 120,
          help: "请求超时（秒）",
          min: 1,
          step: 1,
        },
        {
          key: "applies_to",
          label: "Applies To",
          type: "string_list",
          default: [],
          help: "适用类型，逗号分隔；留空表示全部",
        },
      ],
    },
  ],
};

export function createKnowledgeSystemConfigExtension(currentValue: unknown): SystemConfigExtension {
  return {
    ...KNOWLEDGE_SYSTEM_CONFIG_EXTENSION,
    defaults: {
      document_extraction: resolveDocumentExtractionConfig(currentValue) as unknown as SystemConfigValue,
    },
  };
}

export function resolveDocumentExtractionConfig(value: unknown): DocumentExtractionConfig {
  const record = isRecord(value) ? value : {};
  const cli = isRecord(record.cli) ? record.cli : {};
  const http = isRecord(record.http) ? record.http : {};
  const engine = record.engine === "cli" || record.engine === "http" ? record.engine : "builtin";
  return {
    engine,
    cli: {
      command: typeof cli.command === "string" ? cli.command.trim() : "",
      timeout: positiveIntOrDefault(cli.timeout, 120),
      applies_to: normalizeStringList(cli.applies_to),
    },
    http: {
      endpoint: typeof http.endpoint === "string" ? http.endpoint.trim() : "",
      timeout: positiveIntOrDefault(http.timeout, 120),
      applies_to: normalizeStringList(http.applies_to),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveIntOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}
