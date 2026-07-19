import { isRecord } from "../../utils/guards.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import type {
  DocumentExtractionConfig,
  MemoryConfig,
  SystemConfigData,
  SystemConfigSchema,
  SystemConfigUpdate,
  SystemConfigValue,
  SystemGroupConfig,
  ToolsConfig,
  VectorStoreConfig,
} from "../../contracts/runtime/system-config.js";

const REDACTED_VALUE = "********";
const SENSITIVE_FIELD_NAMES = new Set([
  "password",
  "api_key",
  "secret",
  "token",
  "secret_key",
  "access_token",
  "bearer_token",
  "refresh_token",
]);
const SENSITIVE_FIELD_SUFFIXES = ["_api_key", "_password", "_secret", "_secret_key", "_token"];

export class SystemConfigService {
  private config: SystemConfigData;
  private readonly configPath: string | null;

  constructor(options: { dataRoot?: string | undefined; configPath?: string | undefined } = {}) {
    this.configPath = resolveConfigPath(options);
    this.config = this.loadConfig();
  }

  getSchema(): SystemConfigSchema {
    return buildSystemConfigSchema();
  }

  getConfig(): SystemConfigData {
    return redactSensitiveConfig(cloneConfig(this.config));
  }

  /** 类型化读取 tools 组(防御:缺失/非法字段回退默认值,兼容 Python 写回的不完整 yaml)。 */
  getToolsConfig(): ToolsConfig {
    return normalizeToolsConfig(this.config.tools);
  }

  /** 类型化读取 memory 组。 */
  getMemoryConfig(): MemoryConfig {
    return normalizeMemoryConfig(this.config.memory);
  }

  /** 类型化读取 system 组。 */
  getSystemGroupConfig(): SystemGroupConfig {
    return normalizeSystemGroupConfig(this.config.system);
  }

  /** 类型化读取 vector_store 组(向量库后端选择 + sqlite_vec 连接参数)。 */
  getVectorStoreConfig(): VectorStoreConfig {
    return normalizeVectorStoreConfig(this.config.vector_store);
  }

  /** 类型化读取 document_extraction 组。 */
  getDocumentExtractionConfig(): DocumentExtractionConfig {
    return normalizeDocumentExtractionConfig(this.config.document_extraction);
  }

  updateConfig(update: SystemConfigUpdate): SystemConfigData {
    const sanitized = retainKnownRootGroups(dropRedactedValues(update), this.config);
    this.config = deepMerge(cloneConfig(this.config), sanitized);
    this.saveConfig();
    return this.getConfig();
  }

  reload(): void {
    this.config = this.loadConfig();
  }

  private loadConfig(): SystemConfigData {
    const defaults = buildDefaultConfig();
    if (!this.configPath || !fs.existsSync(this.configPath)) {
      return defaults;
    }
    try {
      const parsed = YAML.parse(fs.readFileSync(this.configPath, "utf8")) as unknown;
      return isRecord(parsed) ? deepMerge(defaults, retainKnownRootGroups(parsed, defaults)) : defaults;
    } catch {
      return defaults;
    }
  }

  private saveConfig(): void {
    if (!this.configPath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, YAML.stringify(this.config), "utf8");
  }
}

function buildDefaultConfig(): SystemConfigData {
  return {
    vector_store: {
      backend: "sqlite_vec",
      sqlite_vec: {
        database_path: "",
        vector_dimension: 0,
        distance_metric: "cosine",
      },
    },
    document_extraction: {
      engine: "builtin",
      cli: { command: "", timeout: 120, applies_to: [] },
      http: { endpoint: "", timeout: 120, applies_to: [] },
    },
    system: {
      max_content_length: 104857600,
    },
    memory: {
      index_max_lines: 200,
      index_max_chars: 25600,
    },
    tools: {
      bash_default_timeout: 120,
      bash_max_timeout: 600,
      bash_max_output: 50000,
      code_default_timeout: 60,
      code_max_timeout: 300,
    },
    context: {
      compression_trigger_ratio: 0.85,
      summarize_max_tokens: 300,
      preserve_recent_turns: 3,
      min_context_budget: 4000,
    },
  };
}

function buildSystemConfigSchema(): SystemConfigSchema {
  return {
    groups: [
      {
        key: "document_extraction",
        label: "文档解析",
        description: "知识库文档文本解析配置",
        fields: [selectField("engine", "Engine", "解析引擎", "builtin", ["builtin", "cli", "http"], false)],
      },
      {
        key: "document_extraction.cli",
        label: "CLI 文档解析",
        description: "通过本地命令解析文档",
        fields: [
          textField("command", "Command", "命令模板，支持 {input}/{output}；MinerU 示例：mineru -p {input} -o {output}", ""),
          numberField("timeout", "Timeout", "命令超时（秒）", 120, { min: 1, step: 1 }),
          stringListField("applies_to", "Applies To", "适用类型，逗号分隔；留空表示全部", []),
        ],
      },
      {
        key: "document_extraction.http",
        label: "HTTP 文档解析",
        description: "通过 HTTP multipart 服务解析文档",
        fields: [
          textField("endpoint", "Endpoint", "文档解析服务地址", ""),
          numberField("timeout", "Timeout", "请求超时（秒）", 120, { min: 1, step: 1 }),
          stringListField("applies_to", "Applies To", "适用类型，逗号分隔；留空表示全部", []),
        ],
      },
      {
        key: "vector_store.sqlite_vec",
        label: "SQLite 向量存储",
        description: "SQLite 向量存储配置",
        fields: [
          textField("database_path", "Database Path", "数据库路径（留空使用默认，相对路径解析到 DB_ROOT）", ""),
          numberField("vector_dimension", "Vector Dimension", "向量维度（0=自动匹配 Embedding 模型）", 0, { min: 0, step: 1 }),
          selectField("distance_metric", "Distance Metric", "距离度量", "cosine", ["cosine", "l2", "ip"], false),
        ],
      },
      {
        key: "system",
        label: "系统配置",
        description: "系统配置",
        fields: [
          numberField("max_content_length", "Max Content Length", "最大内容长度（字节），默认 100MB", 104857600, { min: 1, step: 1 }),
        ],
      },
      {
        key: "memory",
        label: "记忆系统",
        description: "记忆系统配置",
        fields: [
          numberField("index_max_lines", "Index Max Lines", "记忆索引注入最大行数", 200, { min: 10, step: 1 }),
          numberField("index_max_chars", "Index Max Chars", "记忆索引注入最大字符数", 25600, { min: 1024, step: 1 }),
        ],
      },
      {
        key: "tools",
        label: "工具限制",
        description: "工具执行配置",
        fields: [
          numberField("bash_default_timeout", "Bash Default Timeout", "Bash 工具默认超时（秒）", 120, { min: 10, step: 1 }),
          numberField("bash_max_timeout", "Bash Max Timeout", "Bash 工具最大超时（秒）", 600, { min: 60, step: 1 }),
          numberField("bash_max_output", "Bash Max Output", "Bash 工具最大输出（字节）", 50000, { min: 1000, step: 1 }),
          numberField("code_default_timeout", "Code Default Timeout", "代码沙箱默认超时（秒）", 60, { min: 10, step: 1 }),
          numberField("code_max_timeout", "Code Max Timeout", "代码沙箱最大超时（秒）", 300, { min: 60, step: 1 }),
        ],
      },
      {
        key: "context",
        label: "上下文预算",
        description: "上下文预算配置",
        fields: [
          numberField("compression_trigger_ratio", "Compression Trigger Ratio", "触发上下文压缩的 token 使用比例", 0.85, { min: 0.5, max: 0.99, step: 0.1 }),
          numberField("summarize_max_tokens", "Summarize Max Tokens", "LLM 摘要的最大 token 数", 300, { min: 50, step: 1 }),
          numberField("preserve_recent_turns", "Preserve Recent Turns", "压缩时保留的最近对话轮数", 3, { min: 1, max: 20, step: 1 }),
          numberField("min_context_budget", "Min Context Budget", "最小上下文预算 token 数", 4000, { min: 1000, step: 1 }),
        ],
      },
    ],
  };
}

function textField(key: string, label: string, help: string, defaultValue: string) {
  return { key, label, type: "text" as const, default: defaultValue, help };
}

function stringListField(key: string, label: string, help: string, defaultValue: string[]) {
  return { key, label, type: "string_list" as const, default: defaultValue, help };
}

function booleanField(key: string, label: string, help: string, defaultValue: boolean) {
  return { key, label, type: "boolean" as const, default: defaultValue, help };
}

function numberField(
  key: string,
  label: string,
  help: string,
  defaultValue: number | null,
  options: { min?: number; max?: number; step?: number; nullable?: boolean } = {},
) {
  return {
    key,
    label,
    type: "number" as const,
    default: defaultValue,
    help,
    ...options,
  };
}

function selectField(
  key: string,
  label: string,
  help: string,
  defaultValue: string | null,
  values: string[],
  nullable: boolean,
) {
  const options = values.map((value) => ({ value, label: value }));
  if (nullable) {
    options.unshift({ value: "", label: "未设置" });
  }
  const field: SystemConfigSchema["groups"][number]["fields"][number] = {
    key,
    label,
    type: "select" as const,
    default: defaultValue,
    help,
    options,
  };
  if (nullable) {
    field.nullable = true;
  }
  return field;
}

function resolveConfigPath(options: { dataRoot?: string | undefined; configPath?: string | undefined }): string | null {
  if (options.configPath !== undefined) {
    const trimmed = options.configPath.trim();
    return trimmed ? path.resolve(trimmed) : null;
  }
  if (!options.dataRoot?.trim()) {
    return null;
  }
  return path.join(path.resolve(options.dataRoot || path.join(os.homedir(), ".ragsystem")), "config", "app", "config.yaml");
}

function cloneConfig(config: SystemConfigData): SystemConfigData {
  return structuredClone(config) as SystemConfigData;
}

function retainKnownRootGroups(value: unknown, reference: SystemConfigData): SystemConfigData {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => Object.prototype.hasOwnProperty.call(reference, key)),
  ) as SystemConfigData;
}

function deepMerge(base: SystemConfigData, override: SystemConfigData): SystemConfigData {
  const result: SystemConfigData = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current as SystemConfigData, value as SystemConfigData);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function dropRedactedValues(value: unknown, key = ""): unknown {
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const cleaned = dropRedactedValues(childValue, childKey);
      if (cleaned !== undefined) {
        result[childKey] = cleaned;
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => dropRedactedValues(item, key)).filter((item) => item !== undefined);
  }
  if (isSensitiveKey(key) && value === REDACTED_VALUE) {
    return undefined;
  }
  return value;
}

function redactSensitiveValues(value: SystemConfigValue, key = ""): SystemConfigValue {
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactSensitiveValues(childValue as SystemConfigValue, childKey),
      ]),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item, key));
  }
  if (isSensitiveKey(key) && typeof value === "string" && value) {
    return REDACTED_VALUE;
  }
  return value;
}

function redactSensitiveConfig(config: SystemConfigData): SystemConfigData {
  return redactSensitiveValues(config) as SystemConfigData;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return SENSITIVE_FIELD_NAMES.has(normalized) || SENSITIVE_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}



function positiveIntOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

// 默认值须与 buildDefaultConfig() 保持同步(单一来源在 buildDefaultConfig,此处重复仅为 normalize 兜底)。
function normalizeToolsConfig(value: unknown): ToolsConfig {
  const record = isRecord(value) ? value : {};
  return {
    bash_default_timeout: positiveIntOrDefault(record.bash_default_timeout, 120),
    bash_max_timeout: positiveIntOrDefault(record.bash_max_timeout, 600),
    bash_max_output: positiveIntOrDefault(record.bash_max_output, 50000),
    code_default_timeout: positiveIntOrDefault(record.code_default_timeout, 60),
    code_max_timeout: positiveIntOrDefault(record.code_max_timeout, 300),
  };
}

function normalizeMemoryConfig(value: unknown): MemoryConfig {
  const record = isRecord(value) ? value : {};
  return {
    index_max_lines: positiveIntOrDefault(record.index_max_lines, 200),
    index_max_chars: positiveIntOrDefault(record.index_max_chars, 25600),
  };
}

function normalizeSystemGroupConfig(value: unknown): SystemGroupConfig {
  const record = isRecord(value) ? value : {};
  return {
    max_content_length: positiveIntOrDefault(record.max_content_length, 104857600),
  };
}

// 默认值须与 buildDefaultConfig() 的 vector_store 段保持同步(单一来源在 buildDefaultConfig)。
function normalizeVectorStoreConfig(value: unknown): VectorStoreConfig {
  const record = isRecord(value) ? value : {};
  const sqliteVecRecord = isRecord(record.sqlite_vec) ? record.sqlite_vec : {};
  const dimension = sqliteVecRecord.vector_dimension;
  return {
    backend: typeof record.backend === "string" && record.backend.trim() ? record.backend.trim() : "sqlite_vec",
    sqlite_vec: {
      database_path: typeof sqliteVecRecord.database_path === "string" ? sqliteVecRecord.database_path : "",
      vector_dimension:
        typeof dimension === "number" && Number.isFinite(dimension) && dimension >= 0 ? Math.floor(dimension) : 0,
      distance_metric:
        typeof sqliteVecRecord.distance_metric === "string" && sqliteVecRecord.distance_metric.trim()
          ? sqliteVecRecord.distance_metric.trim()
          : "cosine",
    },
  };
}

function normalizeDocumentExtractionConfig(value: unknown): DocumentExtractionConfig {
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

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}
