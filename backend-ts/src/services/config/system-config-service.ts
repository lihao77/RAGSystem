import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import type {
  SystemConfigData,
  SystemConfigSchema,
  SystemConfigUpdate,
  SystemConfigValue,
} from "../../contracts/system-config.js";

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

  updateConfig(update: SystemConfigUpdate): SystemConfigData {
    const sanitized = dropRedactedValues(update) as SystemConfigData;
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
      return isRecord(parsed) ? deepMerge(defaults, parsed as SystemConfigData) : defaults;
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
    llm: {
      provider: "",
      provider_type: "",
      model_name: "deepseek-chat",
      model_map: {},
      temperature: 0.7,
      max_completion_tokens: 4096,
      max_context_tokens: null,
      thinking_budget_tokens: null,
      reasoning_effort: null,
      timeout: 30,
      retry_attempts: 10,
      retry_backoff_factor: 2.5,
    },
    system: {
      max_content_length: 104857600,
    },
    embedding: {
      provider: "",
      provider_type: "",
      model_name: "",
      batch_size: 100,
    },
    hooks: {
      enabled: true,
      workspace_trust: {
        default: "trusted",
        rules: [],
      },
    },
    waiting: {
      enabled: true,
      default_poll_interval_seconds: 3,
      max_poll_interval_seconds: 15,
      idle_wait_timeout_seconds: 300,
      local_cache_ttl_seconds: 600,
      keepalive_interval_seconds: 240,
      keepalive_grace_seconds: 30,
      max_keepalive_rounds: 20,
      allow_provider_keepalive: true,
      hidden_keepalive_token_budget: 8,
    },
    reflection: {
      enabled: true,
      consecutive_tool_failures: 2,
      repeated_tool_calls: 3,
      rounds_without_answer: 6,
      empty_result_count: 2,
      max_reflections_per_run: 3,
    },
    memory: {
      index_max_lines: 200,
      index_max_chars: 25600,
      search_limit: 5,
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
      system_prompt_reserve: 2000,
      min_context_budget: 4000,
    },
  };
}

function buildSystemConfigSchema(): SystemConfigSchema {
  return {
    groups: [
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
        key: "llm",
        label: "LLM 配置",
        description: "LLM 配置 - 支持 ModelAdapter",
        fields: [
          textField("provider", "Provider", "AI 提供商名称（openai/deepseek/openrouter）", ""),
          textField("provider_type", "Provider Type", "Provider 类型（用于精确查找，避免同名冲突）", ""),
          textField("model_name", "Model Name", "默认 Chat 模型名称", "deepseek-chat"),
          numberField("temperature", "Temperature", "生成温度，控制输出随机性", 0.7, { min: 0, max: 2, step: 0.1 }),
          numberField("max_completion_tokens", "Max Completion Tokens", "单次输出的最大 token 数", 4096, { min: 1, step: 1 }),
          numberField("max_context_tokens", "Max Context Tokens", "模型支持的最大上下文窗口", null, { min: 1, step: 1, nullable: true }),
          numberField("thinking_budget_tokens", "Thinking Budget Tokens", "思考预算 token 数（仅部分模型支持）", null, { min: 1, step: 1, nullable: true }),
          selectField("reasoning_effort", "Reasoning Effort", "推理强度（仅部分模型支持）", null, ["low", "medium", "high"], true),
          numberField("timeout", "Timeout", "单次请求超时时间（秒）", 30, { min: 1, step: 1 }),
          numberField("retry_attempts", "Retry Attempts", "失败重试次数", 10, { min: 0, step: 1 }),
          numberField("retry_backoff_factor", "Retry Backoff Factor", "重试退避因子", 2.5, { min: 1, step: 0.1 }),
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
        key: "embedding",
        label: "Embedding 配置",
        description: "Embedding 配置 - 仅支持 ModelAdapter",
        fields: [
          textField("provider", "Provider", "Embedding 提供商名称（留空表示未配置）", ""),
          textField("provider_type", "Provider Type", "Provider 类型（用于精确查找，避免同名冲突）", ""),
          textField("model_name", "Model Name", "Embedding 模型名称", ""),
          numberField("batch_size", "Batch Size", "批处理大小", 100, { min: 1, step: 1 }),
        ],
      },
      {
        key: "hooks",
        label: "Hook 系统",
        description: "Hook 系统配置",
        fields: [booleanField("enabled", "Enabled", "是否启用 Hook 系统", true)],
      },
      {
        key: "hooks.workspace_trust",
        label: "工作区信任",
        description: "工作区信任配置",
        fields: [selectField("default", "Default", "", "trusted", ["trusted", "untrusted"], false)],
      },
      {
        key: "waiting",
        label: "后台等待与保活",
        description: "后台任务等待与 KV cache 保活配置",
        fields: [
          booleanField("enabled", "Enabled", "是否启用后台等待机制", true),
          numberField("default_poll_interval_seconds", "Default Poll Interval Seconds", "默认轮询间隔（秒）", 3, { min: 0.5, step: 0.1 }),
          numberField("max_poll_interval_seconds", "Max Poll Interval Seconds", "最大轮询间隔（秒）", 15, { min: 1, step: 0.1 }),
          numberField("idle_wait_timeout_seconds", "Idle Wait Timeout Seconds", "空闲等待超时（秒）", 300, { min: 10, step: 0.1 }),
          numberField("local_cache_ttl_seconds", "Local Cache Ttl Seconds", "本地缓存 TTL（秒）", 600, { min: 60, step: 0.1 }),
          numberField("keepalive_interval_seconds", "Keepalive Interval Seconds", "KV cache 保活间隔（秒）", 240, { min: 30, step: 0.1 }),
          numberField("keepalive_grace_seconds", "Keepalive Grace Seconds", "保活宽限期（秒）", 30, { min: 5, step: 0.1 }),
          numberField("max_keepalive_rounds", "Max Keepalive Rounds", "最大保活轮数", 20, { min: 1, step: 1 }),
          booleanField("allow_provider_keepalive", "Allow Provider Keepalive", "是否允许 Provider 级别保活", true),
          numberField("hidden_keepalive_token_budget", "Hidden Keepalive Token Budget", "隐藏保活 token 预算", 8, { min: 1, step: 1 }),
        ],
      },
      {
        key: "reflection",
        label: "反思机制",
        description: "反思机制配置（系统级默认，agent 级可覆盖）",
        fields: [
          booleanField("enabled", "Enabled", "是否启用反思机制", true),
          numberField("consecutive_tool_failures", "Consecutive Tool Failures", "连续工具失败 N 次触发反思", 2, { min: 1, step: 1 }),
          numberField("repeated_tool_calls", "Repeated Tool Calls", "同一工具连续调用 N 次触发", 3, { min: 2, step: 1 }),
          numberField("rounds_without_answer", "Rounds Without Answer", "N 轮无答案时触发", 6, { min: 2, step: 1 }),
          numberField("empty_result_count", "Empty Result Count", "空结果累积 N 次触发", 2, { min: 1, step: 1 }),
          numberField("max_reflections_per_run", "Max Reflections Per Run", "单次 run 最大反思次数", 3, { min: 1, step: 1 }),
        ],
      },
      {
        key: "memory",
        label: "记忆系统",
        description: "记忆系统配置",
        fields: [
          numberField("index_max_lines", "Index Max Lines", "记忆索引注入最大行数", 200, { min: 10, step: 1 }),
          numberField("index_max_chars", "Index Max Chars", "记忆索引注入最大字符数", 25600, { min: 1024, step: 1 }),
          numberField("search_limit", "Search Limit", "记忆召回返回条目数上限", 5, { min: 1, max: 50, step: 1 }),
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
          numberField("system_prompt_reserve", "System Prompt Reserve", "系统提示词预留 token 数", 2000, { min: 500, step: 1 }),
          numberField("min_context_budget", "Min Context Budget", "最小上下文预算 token 数", 4000, { min: 1000, step: 1 }),
        ],
      },
    ],
  };
}

function textField(key: string, label: string, help: string, defaultValue: string) {
  return { key, label, type: "text" as const, default: defaultValue, help };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
