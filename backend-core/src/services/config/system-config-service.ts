import { isRecord } from "../../utils/guards.js";

import type {
  SystemLlmConfig,
  SystemConfigData,
  SystemConfigExtension,
  SystemConfigGroup,
  SystemConfigSchema,
  SystemConfigUpdate,
  SystemConfigValue,
  SystemGroupConfig,
  ToolsConfig,
} from "../../contracts/runtime/system-config.js";
import type { ISystemConfigStore } from "../../contracts/runtime/system-config-store.js";

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

export type { SystemConfigExtension } from "../../contracts/runtime/system-config.js";

/**
 * In-process system config projection.
 * Persistence is owned by ISystemConfigStore (Local YAML / SaaS Postgres).
 * Hot-path getters stay sync; mutations and bootstrap load are async.
 */
export class SystemConfigService {
  private config: SystemConfigData = buildDefaultConfig();
  private initialized = false;
  private readonly extensions = new Map<string, SystemConfigExtension>();

  constructor(private readonly store: ISystemConfigStore) {}

  async initialize(): Promise<void> {
    await this.reload();
    this.initialized = true;
  }

  getSchema(): SystemConfigSchema {
    return {
      groups: [
        ...buildSystemConfigSchema().groups,
        ...Array.from(this.extensions.values()).flatMap((extension) => extension.groups),
      ],
    };
  }

  getConfig(): SystemConfigData {
    this.ensureInitialized();
    return redactSensitiveConfig(cloneConfig(this.config));
  }

  getSection(key: string): SystemConfigValue | undefined {
    this.ensureInitialized();
    const value = this.config[key];
    return value === undefined ? undefined : structuredClone(value);
  }

  registerExtension(id: string, extension: SystemConfigExtension): () => void {
    const normalizedId = id.trim();
    if (!normalizedId) throw new Error("System config extension id must not be empty");
    if (this.extensions.has(normalizedId)) throw new Error(`System config extension '${normalizedId}' is already registered`);
    const existingKeys = new Set(this.getSchema().groups.map((group) => group.key));
    for (const group of extension.groups) {
      if (existingKeys.has(group.key)) throw new Error(`System config group '${group.key}' is already registered`);
      existingKeys.add(group.key);
    }
    const stored = {
      defaults: cloneConfig(extension.defaults),
      groups: extension.groups.map((group) => structuredClone(group)),
    };
    this.extensions.set(normalizedId, stored);
    if (this.initialized) this.config = deepMerge(cloneConfig(stored.defaults), this.config);
    return () => {
      this.extensions.delete(normalizedId);
    };
  }

  /** 类型化读取 tools 组(防御:缺失/非法字段回退默认值,兼容 Python 写回的不完整 yaml)。 */
  getToolsConfig(): ToolsConfig {
    this.ensureInitialized();
    return normalizeToolsConfig(this.config.tools);
  }

  /** Typed system LLM fallback. Agent-specific tiers remain higher priority. */
  getLlmConfig(): SystemLlmConfig {
    this.ensureInitialized();
    return normalizeLlmConfig(this.config.llm);
  }

  /** 类型化读取 system 组。 */
  getSystemGroupConfig(): SystemGroupConfig {
    this.ensureInitialized();
    return normalizeSystemGroupConfig(this.config.system);
  }

  async updateConfig(update: SystemConfigUpdate): Promise<SystemConfigData> {
    this.ensureInitialized();
    const sanitized = retainKnownRootGroups(dropRedactedValues(update), this.config) as SystemConfigData;
    const next = normalizeLlmSelection(deepMerge(cloneConfig(this.config), sanitized));
    await this.store.save(next);
    this.config = next;
    return this.getConfig();
  }

  async reload(): Promise<void> {
    const defaults = this.buildDefaults();
    const stored = await this.store.load();
    this.config = normalizeLlmSelection(stored ? deepMerge(defaults, stored) : defaults);
    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("SystemConfigService.initialize() must be awaited before use");
    }
  }

  private buildDefaults(): SystemConfigData {
    let defaults = buildDefaultConfig();
    for (const extension of this.extensions.values()) defaults = deepMerge(defaults, extension.defaults);
    return defaults;
  }
}

function buildDefaultConfig(): SystemConfigData {
  return {
    llm: {
      provider: "",
      provider_type: "",
      model_name: "",
      temperature: 0.7,
      max_completion_tokens: 4096,
      max_context_tokens: 128000,
      extra_params: {},
    },
    system: {
      max_content_length: 104857600,
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
        key: "llm",
        label: "LLM 配置",
        description: "当智能体未配置任何 LLM tier 时使用的系统默认模型",
        fields: [
          textField("provider", "Provider", "AI 提供商名称；留空表示未配置", ""),
          textField("provider_type", "Provider Type", "Provider 类型（用于精确查找，避免同名冲突）", ""),
          textField("model_name", "Model Name", "默认 Chat 模型名称", ""),
          numberField("temperature", "Temperature", "生成温度，控制输出随机性", 0.7, { min: 0, max: 2, step: 0.1 }),
          numberField("max_completion_tokens", "Max Completion Tokens", "单次输出的最大 token 数", 4096, { min: 1, step: 1 }),
          numberField("max_context_tokens", "Max Context Tokens", "模型支持的最大上下文窗口", 128000, { min: 1, step: 1 }),
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

function normalizeLlmConfig(value: unknown): SystemLlmConfig {
  const record = isRecord(value) ? value : {};
  const provider = stringOrDefault(record.provider, "");
  return {
    provider,
    provider_type: provider ? stringOrDefault(record.provider_type, "") : "",
    model_name: provider ? stringOrDefault(record.model_name, "") : "",
    temperature: boundedNumberOrDefault(record.temperature, 0.7, 0, 2),
    max_completion_tokens: positiveIntOrDefault(record.max_completion_tokens, 4096),
    max_context_tokens: positiveIntOrDefault(record.max_context_tokens, 128000),
    extra_params: isRecord(record.extra_params) ? structuredClone(record.extra_params) as Record<string, SystemConfigValue> : {},
  };
}

function normalizeLlmSelection(config: SystemConfigData): SystemConfigData {
  if (!isRecord(config.llm)) return config;
  const provider = stringOrDefault(config.llm.provider, "");
  return {
    ...config,
    llm: {
      ...config.llm,
      max_context_tokens: positiveIntOrDefault(config.llm.max_context_tokens, 128000),
      ...(provider
        ? { provider }
        : { provider: "", provider_type: "", model_name: "" }),
    },
  };
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function boundedNumberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function normalizeSystemGroupConfig(value: unknown): SystemGroupConfig {
  const record = isRecord(value) ? value : {};
  return {
    max_content_length: positiveIntOrDefault(record.max_content_length, 104857600),
  };
}
