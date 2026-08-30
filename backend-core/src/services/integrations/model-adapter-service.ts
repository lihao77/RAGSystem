import { isRecord } from "../../utils/guards.js";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type {
  CatalogModelsResult,
  CatalogProvidersResult,
  ModelModality,
  ModelProviderConfig,
  ProviderModelEntry,
  ProviderPayload,
  ProviderTypeInfo,
  TestProviderRequest,
} from "../../contracts/integrations/model-adapter.js";
import { MODEL_MODALITIES, THINKING_STRENGTH_LEVELS, type ThinkingStrengthLevel } from "../../contracts/integrations/model-adapter.js";
import { ModelsDevCatalog } from "./models-dev-catalog.js";
import {
  DEFAULT_PROVIDER_RETRY_ATTEMPTS,
  DEFAULT_PROVIDER_RETRY_BACKOFF_FACTOR,
  DEFAULT_PROVIDER_RETRY_DELAY_SECONDS,
  DEFAULT_PROVIDER_TIMEOUT_SECONDS,
  externalCallPolicy,
  LlmProviderClient,
  type ExternalCallMetrics,
  type ProviderConfig,
} from "@ragsystem/agent-llm";
import { DEFAULT_ENDPOINTS, PROVIDER_TYPES, PROVIDER_TYPE_SET, providerTypeSpec } from "@ragsystem/agent-llm";

const PROVIDERS_CONFIG_RELATIVE_PATH = path.join("config", "model_adapter", "providers.yaml");

const UPDATE_FIELDS = [
  "provider_type",
  "api_format",
  "thinking_kind",
  "api_key",
  "timeout",
  "retry_attempts",
  "retry_delay",
  "retry_backoff_factor",
  "supports_prompt_caching",
  "cache_ttl_seconds",
  "models",
  "api_endpoint",
] as const;

/** 厂商思考形状合法值（透传 agent-llm describeThinking 覆盖）。 */
const THINKING_KINDS = new Set(["effort", "budget", "toggle", "none"]);

/** 已废弃的 provider 级字段（模型映射/运行参数已下沉到模型条目/厂商目录临时补丁），加载/写入时剥离。 */
const LEGACY_PROVIDER_FIELDS = [
  "model",
  "model_map",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "max_context_tokens",
  "supports_function_calling",
  "supports_vision",
  "catalog_provider_id",
] as const;

export class ModelAdapterServiceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ModelAdapterServiceError";
    this.statusCode = statusCode;
  }
}

export class ModelAdapterService {
  private readonly providers = new Map<string, ModelProviderConfig>();
  private readonly providersConfigPath: string | null;
  private readonly catalog: ModelsDevCatalog;

  constructor(options: {
    dataRoot?: string | undefined;
    providersConfigPath?: string | undefined;
  } = {}) {
    this.providersConfigPath = resolveProvidersConfigPath(options);
    this.catalog = new ModelsDevCatalog({ dataRoot: options.dataRoot });
    this.loadProvidersFromDisk();
  }

  /** Models.dev 目录厂商摘要（配置界面建议/自动填充用；拉不到时 available:false 降级）。 */
  async listCatalogProviders(): Promise<CatalogProvidersResult> {
    return this.catalog.listProviders();
  }

  /** Models.dev 目录单厂商模型列表；未知厂商 id → 404。 */
  async listCatalogModels(catalogProviderId: string): Promise<CatalogModelsResult> {
    const providerId = String(catalogProviderId ?? "").trim();
    const result = await this.catalog.listModels(providerId);
    if (!result) {
      throw new ModelAdapterServiceError(`目录厂商不存在: ${providerId}`, 404);
    }
    return result;
  }

  private isKnownApiFormat(apiFormat: string): boolean {
    return PROVIDER_TYPE_SET.has(apiFormat);
  }

  /** API 格式封闭清单（agent-llm 协议方言），供前端格式下拉与端点/扩展字段元数据。 */
  listApiFormats(): ProviderTypeInfo[] {
    return PROVIDER_TYPES.map((apiFormat) => ({
      value: apiFormat,
      label: labelProviderType(apiFormat),
      default_endpoint: DEFAULT_ENDPOINTS[apiFormat] ?? "",
      config_fields: providerConfigFields(apiFormat),
    }));
  }

  listProviders(): ModelProviderConfig[] {
    return Array.from(this.providers.entries()).map(([providerKey, config]) =>
      this.cloneProvider(providerKey, config),
    );
  }

  /** Replace the in-memory provider snapshot supplied by a deployment runtime. */
  replaceRuntimeProviders(providers: readonly ModelProviderConfig[]): void {
    const next = new Map<string, ModelProviderConfig>();
    for (const value of providers) {
      const config = cloneProviderConfig(value);
      config.name = String(config.name ?? "").trim();
      config.provider_type = String(config.provider_type ?? "").trim().toLowerCase();
      // 与磁盘水合同规：runtime 快照也走别名归一（openai_compatible_chat 等），避免同一条目两条路径判定不一
      config.api_format = canonicalizeProviderType(config.api_format, undefined);
      const providerKey = String(value.key ?? "").trim() || makeProviderKey(config);
      if (!providerKey || !config.name) {
        throw new ModelAdapterServiceError(`无效的运行时 Provider 配置: ${providerKey || config.name || "unknown"}`, 500);
      }
      // 无效 API 格式跳过而非抛错：持久化条目残留（旧形态/未配置）属正常状态，
      // 水合失败会让整个租户不可用。create/update 路径仍严格校验（400）。
      if (!isChatProviderConfig(config, (format) => this.isKnownApiFormat(format))) {
        continue;
      }
      normalizeProviderRuntimeConfig(config);
      next.set(providerKey, config);
    }
    this.providers.clear();
    for (const [providerKey, config] of next) this.providers.set(providerKey, config);
  }

  hasProvider(providerKey: string): boolean {
    return this.providers.has(providerKey);
  }

  /**
   * 按 key 取单个 provider 配置（克隆，避免外部 mutate 内部状态）。无则 null。
   * 对应 hasProvider 的值读取口，避免每次 listProviders() 克隆全部 provider。
   */
  getProvider(providerKey: string): ModelProviderConfig | null {
    const config = this.providers.get(providerKey);
    return config ? cloneProviderConfig(config) : null;
  }

  getProviderMetrics(providerKey: string): { provider_key: string; resilience: ExternalCallMetrics | null } {
    const provider = this.providers.get(providerKey);
    if (!provider) {
      throw new ModelAdapterServiceError(`Provider 不存在: ${providerKey}`, 404);
    }
    return {
      provider_key: providerKey,
      resilience: externalCallPolicy.snapshot(providerCircuitKey(provider))[0] ?? null,
    };
  }

  /**
   * Validate + normalize a create payload without mutating runtime state.
   * Callers that own persistence (SaaS Application) write the store first, then hydrate.
   */
  buildCreateProvider(data: ProviderPayload): { key: string; config: ModelProviderConfig } {
    const config = this.buildCreateConfig(data);
    const key = makeProviderKey(config);
    if (!key) {
      throw new ModelAdapterServiceError("Provider 配置必须包含 name, provider_type, api_key", 400);
    }
    return { key, config };
  }

  /**
   * Validate + normalize an update against an existing config without mutating runtime state.
   */
  buildUpdateProvider(
    providerKey: string,
    existing: ModelProviderConfig,
    data: ProviderPayload,
  ): { key: string; config: ModelProviderConfig } {
    if (Object.keys(data).length === 0) {
      throw new ModelAdapterServiceError("请求数据不能为空", 400);
    }
    this.ensureProviderRequestShape(data, { requireModels: false });

    const config = cloneProviderConfig(existing);
    for (const field of UPDATE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(data, field)) {
        continue;
      }
      const value = data[field];
      if (field === "api_key" && !String(value ?? "").trim()) {
        continue;
      }
      assignProviderField(config, field, value);
    }

    normalizeProviderRuntimeConfig(config);
    if (!String(config.provider_type ?? "").trim()) {
      throw new ModelAdapterServiceError("缺少必需字段: provider_type", 400);
    }
    config.api_format = canonicalizeProviderType(config.api_format, undefined);
    if (!this.isKnownApiFormat(config.api_format)) {
      throw new ModelAdapterServiceError(`不支持的 API 格式: ${config.api_format || "(空)"}`, 400);
    }
    return { key: providerKey, config };
  }

  /** Validate a full reorder key list against the current runtime snapshot. */
  buildReorderProviders(providerKeys: string[]): string[] {
    const normalizedKeys = providerKeys.map((key) => String(key).trim());
    if (!normalizedKeys.every(Boolean)) {
      throw new ModelAdapterServiceError("provider_keys 包含非法 Provider key", 400);
    }
    if (new Set(normalizedKeys).size !== normalizedKeys.length) {
      throw new ModelAdapterServiceError("Provider 顺序列表包含重复 key", 400);
    }

    const currentKeys = Array.from(this.providers.keys());
    const missing = currentKeys.filter((key) => !normalizedKeys.includes(key));
    const unknown = normalizedKeys.filter((key) => !this.providers.has(key));
    if (missing.length || unknown.length) {
      const details: string[] = [];
      if (missing.length) {
        details.push(`缺少 Provider: ${missing.join(", ")}`);
      }
      if (unknown.length) {
        details.push(`未知 Provider: ${unknown.join(", ")}`);
      }
      throw new ModelAdapterServiceError(details.join("; "), 400);
    }
    return normalizedKeys;
  }

  createProvider(data: ProviderPayload): string {
    const { key, config } = this.buildCreateProvider(data);
    if (this.providers.has(key)) {
      throw new ModelAdapterServiceError(`Provider 已存在: ${key}`, 409);
    }
    this.providers.set(key, config);
    this.saveProvidersToDisk();
    return key;
  }

  updateProvider(providerKey: string, data: ProviderPayload): string {
    const existing = this.providers.get(providerKey);
    if (!existing) {
      throw new ModelAdapterServiceError(`Provider 不存在: ${providerKey}`, 404);
    }
    const { key, config } = this.buildUpdateProvider(providerKey, existing, data);
    this.providers.set(key, config);
    externalCallPolicy.reset(providerCircuitKey(existing));
    this.saveProvidersToDisk();
    return key;
  }

  reorderProviders(data: { provider_keys: string[] }): string[] {
    const normalizedKeys = this.buildReorderProviders(data.provider_keys);
    const reordered = new Map<string, ModelProviderConfig>();
    for (const key of normalizedKeys) {
      const provider = this.providers.get(key);
      if (provider) {
        reordered.set(key, provider);
      }
    }
    this.providers.clear();
    for (const [key, provider] of reordered) {
      this.providers.set(key, provider);
    }
    this.saveProvidersToDisk();
    return normalizedKeys;
  }

  deleteProvider(providerKey: string): void {
    const provider = this.providers.get(providerKey);
    if (!provider || !this.providers.delete(providerKey)) {
      throw new ModelAdapterServiceError(`Provider 不存在: ${providerKey}`, 404);
    }
    externalCallPolicy.reset(providerCircuitKey(provider));
    this.saveProvidersToDisk();
  }

  validateTestProviderRequest(data: TestProviderRequest): void {
    if (!String(data.provider ?? "").trim()) {
      throw new ModelAdapterServiceError("请提供 Provider", 400);
    }
    if (!String(data.prompt ?? "").trim()) {
      throw new ModelAdapterServiceError("请提供测试内容", 400);
    }
  }

  checkProviderAvailability(providerKey: string): {
    provider_key: string;
    is_available: boolean;
    checks: Record<string, boolean>;
    error: string | null;
  } {
    const provider = this.providers.get(providerKey);
    if (!provider) {
      throw new ModelAdapterServiceError(`Provider 不存在: ${providerKey}`, 404);
    }
    const checks = {
      provider_exists: true,
      api_format_supported: this.isKnownApiFormat(String(provider.api_format ?? "").trim().toLowerCase()),
      api_key_configured: Boolean(String(provider.api_key ?? "").trim()),
      chat_model_configured: provider.models.some((model) => Boolean(model.name)),
    };
    const isAvailable =
      checks.api_format_supported &&
      checks.api_key_configured &&
      checks.chat_model_configured;
    return {
      provider_key: providerKey,
      is_available: isAvailable,
      checks,
      error: isAvailable ? null : summarizeAvailabilityFailure(provider, checks, checks.chat_model_configured),
    };
  }

  async testProvider(data: TestProviderRequest): Promise<Record<string, unknown>> {
    this.validateTestProviderRequest(data);
    const provider = this.resolveProviderForTest(data);
    const requestedModel = firstModelFromValue(data.model);
    const entry = requestedModel ? findModelEntryByName(provider, requestedModel) : provider.models[0] ?? null;
    const model = requestedModel ?? entry?.name ?? null;
    if (!model) {
      throw new ModelAdapterServiceError("Provider 未配置 chat 模型", 400);
    }

    const startedAt = Date.now();
    try {
      // 测连通性用真实 agent-llm client（LlmProviderClient 无状态）；mock 假响应无意义。
      // agent-llm 按 API 格式分发：provider_type（厂商）在桥接处替换为 api_format。
      const response = await new LlmProviderClient().complete({
        messages: [{ role: "user", content: data.prompt ?? "" }],
        model,
        provider: { ...provider, provider_type: provider.api_format ?? provider.provider_type } as unknown as ProviderConfig,
        temperature: entry?.temperature ?? 0.2,
        maxCompletionTokens: entry?.max_completion_tokens ?? 500,
      });
      return {
        content: response.content,
        error: null,
        model,
        provider: provider.name,
        cost: null,
        latency: (Date.now() - startedAt) / 1000,
        usage: null,
        finish_reason: response.finishReason ?? null,
      };
    } catch (error) {
      return {
        content: null,
        error: error instanceof Error ? error.message : String(error),
        model,
        provider: provider.name,
        cost: null,
        latency: (Date.now() - startedAt) / 1000,
        usage: null,
        finish_reason: null,
      };
    }
  }

  private resolveProviderForTest(data: TestProviderRequest): ModelProviderConfig {
    const providerRef = String(data.provider ?? "").trim();
    const providerType = String(data.provider_type ?? "").trim().toLowerCase();
    const provider =
      this.providers.get(providerRef) ??
      Array.from(this.providers.values()).find((item) => {
        if (providerType && item.provider_type !== providerType) {
          return false;
        }
        return item.name === providerRef || normalizeProviderRef(item.name) === normalizeProviderRef(providerRef);
      });
    if (!provider) {
      throw new ModelAdapterServiceError(`Provider 不存在: ${providerRef}`, 404);
    }
    return cloneProviderConfig(provider);
  }

  private buildCreateConfig(data: ProviderPayload): ModelProviderConfig {
    if (Object.keys(data).length === 0) {
      throw new ModelAdapterServiceError("请求数据不能为空", 400);
    }

    const normalized = canonicalizeProviderConfig(data);
    for (const field of ["provider_type", "name", "api_key"] as const) {
      if (!String(normalized[field] ?? "").trim()) {
        throw new ModelAdapterServiceError(`缺少必需字段: ${field}`, 400);
      }
    }
    if (!this.isKnownApiFormat(String(normalized.api_format ?? ""))) {
      throw new ModelAdapterServiceError(
        String(normalized.api_format ?? "").trim()
          ? `不支持的 API 格式: ${normalized.api_format}`
          : "缺少必需字段: api_format",
        400,
      );
    }

    this.ensureProviderRequestShape(normalized, { requireModels: true });
    const config = normalized as ModelProviderConfig;
    config.name = String(config.name);
    config.provider_type = String(config.provider_type).trim().toLowerCase();
    normalizeProviderRuntimeConfig(config);
    return cloneProviderConfig(config);
  }

  private ensureProviderRequestShape(data: ProviderPayload, options: { requireModels: boolean }): void {
    const normalized = canonicalizeProviderConfig(data);
    const models = normalized.models;
    if (models !== undefined && !Array.isArray(models)) {
      throw new ModelAdapterServiceError("models 必须是数组", 400);
    }
    const entries = Array.isArray(models) ? models : [];
    for (const entry of entries) {
      if (!isRecord(entry) || !String(entry.name ?? "").trim()) {
        throw new ModelAdapterServiceError("每条模型必须包含非空 name", 400);
      }
      for (const field of ["input_modalities", "output_modalities"] as const) {
        if (entry[field] !== undefined && !Array.isArray(entry[field])) {
          throw new ModelAdapterServiceError(
            `${field === "input_modalities" ? "输入" : "输出"}模态必须是数组`,
            400,
          );
        }
      }
      if (entry.thinking_levels !== undefined && !Array.isArray(entry.thinking_levels)) {
        throw new ModelAdapterServiceError("思考档位必须是数组", 400);
      }
    }
    const names = entries.map((entry) => String((entry as Record<string, unknown>).name ?? "").trim());
    if (new Set(names).size !== names.length) {
      throw new ModelAdapterServiceError("模型名不能重复", 400);
    }
    if (options.requireModels && entries.length === 0) {
      throw new ModelAdapterServiceError("至少配置一个模型", 400);
    }
  }

  private cloneProvider(providerKey: string, config: ModelProviderConfig): ModelProviderConfig {
    return {
      ...cloneProviderConfig(config),
      key: providerKey,
      is_loaded: true,
    };
  }

  private loadProvidersFromDisk(): void {
    if (!this.providersConfigPath || !fs.existsSync(this.providersConfigPath)) {
      return;
    }
    const raw = fs.readFileSync(this.providersConfigPath, "utf8");
    const parsed = YAML.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return;
    }

    this.providers.clear();
    for (const [providerKey, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      const normalized = canonicalizeProviderConfig(value);
      const config = normalized as ModelProviderConfig;
      config.name = String(config.name ?? "");
      config.provider_type = String(config.provider_type ?? "").trim().toLowerCase();
      if (!config.name || !isChatProviderConfig(config, (format) => this.isKnownApiFormat(format))) {
        continue;
      }
      normalizeProviderRuntimeConfig(config);
      this.providers.set(providerKey, cloneProviderConfig(config));
    }
  }

  private saveProvidersToDisk(): void {
    if (!this.providersConfigPath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.providersConfigPath), { recursive: true });
    const payload = Object.fromEntries(
      Array.from(this.providers.entries()).map(([providerKey, config]) => [providerKey, cloneProviderConfig(config)]),
    );
    fs.writeFileSync(this.providersConfigPath, YAML.stringify(payload), "utf8");
  }
}

function resolveProvidersConfigPath(options: {
  dataRoot?: string | undefined;
  providersConfigPath?: string | undefined;
}): string | null {
  if (options.providersConfigPath !== undefined) {
    const trimmed = options.providersConfigPath.trim();
    return trimmed ? path.resolve(trimmed) : null;
  }
  if (!options.dataRoot?.trim()) {
    return null;
  }
  return path.join(path.resolve(options.dataRoot), PROVIDERS_CONFIG_RELATIVE_PATH);
}

function canonicalizeProviderConfig(config: ProviderPayload): ProviderPayload {
  const normalized: ProviderPayload = { ...config };
  // provider_type = 厂商（自由字符串，仅归一大小写/空白）；API 格式别名归一只作用于 api_format。
  normalized.provider_type = String(normalized.provider_type ?? "").trim().toLowerCase();
  normalized.api_format = canonicalizeProviderType(normalized.api_format, normalized.api_mode);
  return normalized;
}

/** chat provider 有效 = 厂商非空 + API 格式在 kernel 封闭清单（水合/加载过滤用）。 */
function isChatProviderConfig(
  config: ModelProviderConfig,
  isKnownApiFormat: (apiFormat: string) => boolean,
): boolean {
  return Boolean(String(config.provider_type ?? "").trim())
    && isKnownApiFormat(String(config.api_format ?? "").trim().toLowerCase());
}

function canonicalizeProviderType(providerType: unknown, apiMode: unknown): string {
  const rawProviderType = String(providerType ?? "").trim().toLowerCase();
  const normalizedApiMode = String(apiMode ?? "").trim().toLowerCase();
  if (rawProviderType === "openai") {
    return normalizedApiMode === "responses" ? "openai_resp" : "openai_chat";
  }
  if (rawProviderType === "openai_responses" || rawProviderType === "openai_resp") {
    return "openai_resp";
  }
  if (rawProviderType === "openai_chat_completions" || rawProviderType === "openai_chat") {
    return "openai_chat";
  }
  if (rawProviderType === "openai_compatible_chat" || rawProviderType === "openai_proxy") {
    return "openai_proxy";
  }
  return rawProviderType;
}

function labelProviderType(providerType: string): string {
  const labels: Record<string, string> = {
    openai_resp: "OpenAI Responses",
    openai_chat: "OpenAI Chat",
    openai_proxy: "OpenAI Compatible",
    gemini: "Google Gemini",
  };
  return labels[providerType] ?? providerType.charAt(0).toUpperCase() + providerType.slice(1);
}

function providerConfigFields(providerType: string): ProviderTypeInfo["config_fields"] {
  const fields: ProviderTypeInfo["config_fields"] = [
    {
      key: "timeout",
      label: "响应超时（秒）",
      type: "number",
      default: DEFAULT_PROVIDER_TIMEOUT_SECONDS,
      help: "",
      min: 5,
      options: [],
    },
    {
      key: "retry_attempts",
      label: "最大重试次数",
      type: "number",
      default: DEFAULT_PROVIDER_RETRY_ATTEMPTS,
      help: "",
      min: 0,
      options: [],
    },
    {
      key: "retry_delay",
      label: "首次重试间隔（秒）",
      type: "number",
      default: DEFAULT_PROVIDER_RETRY_DELAY_SECONDS,
      help: "",
      min: 0,
      options: [],
    },
    {
      key: "retry_backoff_factor",
      label: "重试间隔倍数",
      type: "number",
      default: DEFAULT_PROVIDER_RETRY_BACKOFF_FACTOR,
      help: "",
      min: 1,
      options: [],
    },
  ];

  const capabilities = providerTypeSpec(providerType);
  if (capabilities?.exposesPromptCacheToggle) {
    fields.unshift({
      key: "supports_prompt_caching",
      label: "启用 Prompt Cache",
      type: "boolean",
      default: true,
      help: capabilities.promptCacheMode === "automatic_prefix"
        ? "允许当前 Provider 使用并统计自动前缀缓存；不会发送未支持的缓存字段。"
        : "控制当前 Provider 支持的 cache_control 或 prompt_cache_key 缓存参数。",
      options: [],
    });
  }
  if (capabilities?.supportsPromptCacheTtl) {
    fields.splice(1, 0,
      {
        key: "cache_ttl_seconds",
        label: "Cache TTL (s)",
        type: "number",
        default: 300,
        help: "Provider KV cache 的滑动失效阈值。",
        options: [],
      },
    );
  }

  return fields;
}

function makeProviderKey(config: Pick<ModelProviderConfig, "name" | "provider_type">): string {
  const name = String(config.name ?? "").trim().toLowerCase().replaceAll(" ", "_");
  const providerType = String(config.provider_type ?? "").trim().toLowerCase();
  return name && providerType ? `${name}_${providerType}` : "";
}

/**
 * 运行时形态归一：剥离已废弃的 provider 级字段（模型映射/运行参数），models 归一为模型条目数组。
 * create/update/load/replaceRuntime 四个入口共用，保证内存与磁盘上的 provider 恒为新形态。
 */
function normalizeProviderRuntimeConfig(config: ModelProviderConfig): void {
  for (const field of LEGACY_PROVIDER_FIELDS) {
    delete config[field];
  }
  const thinkingKind = String(config.thinking_kind ?? "").trim().toLowerCase();
  // thinking_kind 非法值静默剔除（回落格式默认形状）：形状声明是增强项，拼写错误不应阻断
  // 连接配置；对比 api_format 是封闭枚举、直接 400。
  if (thinkingKind && THINKING_KINDS.has(thinkingKind)) {
    config.thinking_kind = thinkingKind;
  } else {
    delete config.thinking_kind;
  }
  config.models = normalizeModels(config.models);
}

/** 模型条目数组归一：只保留已知键，name trim 非空去重，数值/布尔/模态非法值丢弃；非数组 → []。 */
function normalizeModels(value: unknown): ProviderModelEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const models: ProviderModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = String(item.name ?? "").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    const entry: ProviderModelEntry = { name };
    const temperature = asOptionalNumber(item.temperature);
    if (temperature !== undefined) entry.temperature = temperature;
    const maxCompletionTokens = asOptionalNumber(item.max_completion_tokens);
    if (maxCompletionTokens !== undefined) entry.max_completion_tokens = maxCompletionTokens;
    const maxContextTokens = asOptionalNumber(item.max_context_tokens);
    if (maxContextTokens !== undefined) entry.max_context_tokens = maxContextTokens;
    if (item.supports_function_calling === true) entry.supports_function_calling = true;
    const inputModalities = normalizeModalityList(item.input_modalities);
    if (inputModalities) entry.input_modalities = inputModalities;
    const outputModalities = normalizeModalityList(item.output_modalities);
    if (outputModalities) entry.output_modalities = outputModalities;
    const thinkingLevels = normalizeThinkingLevelList(item.thinking_levels);
    if (thinkingLevels) entry.thinking_levels = thinkingLevels;
    if (item.reasoning_field === "reasoning_content" || item.reasoning_field === "reasoning_details") {
      entry.reasoning_field = item.reasoning_field;
    }
    models.push(entry);
    seen.add(name);
  }
  return models;
}

/** 思考档位子集归一：小写 trim、只留已知强度档位、按全集顺序输出；非数组/过滤后为空 → undefined。 */
function normalizeThinkingLevelList(value: unknown): ThinkingStrengthLevel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const known = new Set<string>(THINKING_STRENGTH_LEVELS);
  const seen = new Set<string>();
  for (const item of value) {
    const token = String(item ?? "").trim().toLowerCase();
    if (token && known.has(token)) {
      seen.add(token);
    }
  }
  const result = THINKING_STRENGTH_LEVELS.filter((level) => seen.has(level));
  return result.length > 0 ? [...result] : undefined;
}

/** 模态数组归一：小写 trim、只留已知值、去重；非数组/过滤后为空 → undefined（键不落盘）。 */
function normalizeModalityList(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const known = new Set<string>(MODEL_MODALITIES);
  const result: ModelModality[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const token = String(item ?? "").trim().toLowerCase();
    if (!token || !known.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    result.push(token as ModelModality);
  }
  return result.length > 0 ? result : undefined;
}

/** 按名称查模型条目（trim 精确匹配）；找不到返回 null（模型未在目录中不算错误）。 */
function findModelEntryByName(provider: ModelProviderConfig, modelName: string): ProviderModelEntry | null {
  const target = modelName.trim();
  return provider.models.find((model) => model.name === target) ?? null;
}

function assignProviderField(config: ModelProviderConfig, field: (typeof UPDATE_FIELDS)[number], value: unknown): void {
  switch (field) {
    case "provider_type":
      config.provider_type = String(value ?? "").trim().toLowerCase();
      break;
    case "api_format":
      config.api_format = canonicalizeProviderType(value, undefined);
      break;
    case "thinking_kind":
      config.thinking_kind = String(value ?? "").trim().toLowerCase();
      break;
    case "api_key":
      if (value === undefined) {
        delete config.api_key;
      } else {
        config.api_key = String(value ?? "");
      }
      break;
    case "timeout":
      setNumberField(config, "timeout", value);
      break;
    case "retry_attempts":
      setNumberField(config, "retry_attempts", value);
      break;
    case "retry_delay":
      setNumberField(config, "retry_delay", value);
      break;
    case "retry_backoff_factor":
      setNumberField(config, "retry_backoff_factor", value);
      break;
    case "supports_prompt_caching":
      config.supports_prompt_caching = Boolean(value);
      break;
    case "cache_ttl_seconds":
      if (typeof value === "number") {
        config.cache_ttl_seconds = value;
      } else {
        delete config.cache_ttl_seconds;
      }
      break;
    case "models":
      config.models = normalizeModels(value);
      break;
    case "api_endpoint":
      if (value === undefined) {
        delete config.api_endpoint;
      } else {
        config.api_endpoint = String(value ?? "");
      }
      break;
  }
}

function setNumberField(
  config: ModelProviderConfig,
  field:
    | "timeout"
    | "retry_attempts"
    | "retry_delay"
    | "retry_backoff_factor",
  value: unknown,
): void {
  const numberValue = asOptionalNumber(value);
  if (numberValue === undefined) {
    delete config[field];
    return;
  }
  config[field] = numberValue;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function cloneProviderConfig(config: ModelProviderConfig): ModelProviderConfig {
  return structuredClone(config) as ModelProviderConfig;
}

function firstModelFromValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = String(item ?? "").trim();
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function summarizeAvailabilityFailure(
  provider: ModelProviderConfig,
  checks: Record<string, boolean>,
  taskReady: boolean,
): string {
  if (!checks.api_format_supported) {
    return `不支持的 API 格式: ${provider.api_format || "(未配置)"}`;
  }
  if (!checks.api_key_configured) {
    return "缺少 Provider API key";
  }
  if (!taskReady) {
    return "Provider 未配置可用模型";
  }
  return "Provider 不可用";
}

function normalizeProviderRef(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function providerCircuitKey(provider: ModelProviderConfig): string {
  return `provider:${provider.key ?? provider.name ?? provider.provider_type}`;
}
