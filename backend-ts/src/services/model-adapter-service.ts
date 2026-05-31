import type {
  ModelMap,
  ModelMapValue,
  ModelProviderConfig,
  ProviderPayload,
  ProviderTypeInfo,
  TestProviderRequest,
} from "../contracts/model-adapter.js";

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai_resp: "https://api.openai.com/v1",
  openai_chat: "https://api.openai.com/v1",
  openai_proxy: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  modelscope: "https://api-inference.modelscope.cn/v1",
  rerank_api: "",
};

const PROVIDER_TYPES = [
  "openai_resp",
  "openai_chat",
  "openai_proxy",
  "anthropic",
  "deepseek",
  "openrouter",
  "modelscope",
  "rerank_api",
] as const;
const PROVIDER_TYPE_SET = new Set<string>(PROVIDER_TYPES);

const UPDATE_FIELDS = [
  "api_key",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "max_context_tokens",
  "thinking_budget_tokens",
  "reasoning_effort",
  "timeout",
  "retry_attempts",
  "retry_delay",
  "retry_backoff_factor",
  "supports_function_calling",
  "model_map",
  "api_endpoint",
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

  listProviderTypes(): ProviderTypeInfo[] {
    return PROVIDER_TYPES.map((providerType) => ({
      value: providerType,
      label: labelProviderType(providerType),
      default_endpoint: DEFAULT_ENDPOINTS[providerType] ?? "",
      config_fields: [],
    }));
  }

  listProviders(): ModelProviderConfig[] {
    return Array.from(this.providers.entries()).map(([providerKey, config]) =>
      this.cloneProvider(providerKey, config),
    );
  }

  hasProvider(providerKey: string): boolean {
    return this.providers.has(providerKey);
  }

  createProvider(data: ProviderPayload): string {
    const config = this.buildCreateConfig(data);
    const providerKey = makeProviderKey(config);
    if (!providerKey) {
      throw new ModelAdapterServiceError("Provider 配置必须包含 name, provider_type, api_key", 400);
    }
    if (this.providers.has(providerKey)) {
      throw new ModelAdapterServiceError(`Provider 已存在: ${providerKey}`, 409);
    }

    this.providers.set(providerKey, config);
    return providerKey;
  }

  updateProvider(providerKey: string, data: ProviderPayload): string {
    if (Object.keys(data).length === 0) {
      throw new ModelAdapterServiceError("请求数据不能为空", 400);
    }

    const existing = this.providers.get(providerKey);
    if (!existing) {
      throw new ModelAdapterServiceError(`Provider 不存在: ${providerKey}`, 404);
    }

    this.ensureProviderRequestShape(data);

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

    rebuildModelsFromModelMap(config);
    this.ensureProviderRuntimeShape(config);
    this.providers.set(providerKey, config);
    return providerKey;
  }

  reorderProviders(data: { provider_keys: string[] }): string[] {
    const normalizedKeys = data.provider_keys.map((key) => String(key).trim());
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
    return normalizedKeys;
  }

  deleteProvider(providerKey: string): void {
    if (!this.providers.delete(providerKey)) {
      throw new ModelAdapterServiceError(`Provider 不存在: ${providerKey}`, 404);
    }
  }

  validateTestProviderRequest(data: TestProviderRequest): void {
    if (!String(data.provider ?? "").trim()) {
      throw new ModelAdapterServiceError("请提供 Provider", 400);
    }
    if (!String(data.prompt ?? "").trim()) {
      throw new ModelAdapterServiceError("请提供测试内容", 400);
    }
    const task = data.task ?? "chat";
    if (!["chat", "embedding", "rerank"].includes(task)) {
      throw new ModelAdapterServiceError(`不支持的任务类型: ${task}`, 400);
    }
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

    this.ensureProviderRequestShape(normalized);
    const config = normalized as ModelProviderConfig;
    config.name = String(config.name);
    config.provider_type = String(config.provider_type).toLowerCase();
    if (!PROVIDER_TYPE_SET.has(config.provider_type)) {
      throw new ModelAdapterServiceError(`不支持的 Provider 类型: ${config.provider_type}`, 400);
    }
    rebuildModelsFromModelMap(config);
    this.ensureProviderRuntimeShape(config);
    return cloneProviderConfig(config);
  }

  private ensureProviderRequestShape(data: ProviderPayload): void {
    const normalized = canonicalizeProviderConfig(data);
    const modelMap = normalized.model_map;
    if (modelMap !== undefined && !isRecord(modelMap)) {
      throw new ModelAdapterServiceError("model_map 必须是对象", 400);
    }
    if (Array.isArray(normalized.model)) {
      throw new ModelAdapterServiceError("model 必须是字符串", 400);
    }

    for (const [task, value] of Object.entries(isRecord(modelMap) ? modelMap : {})) {
      if (!String(task).trim()) {
        throw new ModelAdapterServiceError("model_map 不能包含空任务名", 400);
      }
      if (Array.isArray(value)) {
        if (!value.some((item) => String(item ?? "").trim())) {
          throw new ModelAdapterServiceError(`model_map.${task} 至少需要一个模型`, 400);
        }
        continue;
      }
      if (!String(value ?? "").trim()) {
        throw new ModelAdapterServiceError(`model_map.${task} 不能为空`, 400);
      }
    }
  }

  private ensureProviderRuntimeShape(config: ModelProviderConfig): void {
    if (config.provider_type !== "rerank_api") {
      return;
    }
    if (!String(config.api_endpoint ?? "").trim()) {
      throw new ModelAdapterServiceError("rerank_api Provider 必须填写 API Endpoint", 400);
    }
    if (!normalizeModelValue(config.model_map.rerank)) {
      throw new ModelAdapterServiceError("rerank_api Provider 必须配置 model_map.rerank", 400);
    }
  }

  private cloneProvider(providerKey: string, config: ModelProviderConfig): ModelProviderConfig {
    return {
      ...cloneProviderConfig(config),
      key: providerKey,
      is_loaded: true,
    };
  }
}

function canonicalizeProviderConfig(config: ProviderPayload): ProviderPayload {
  const normalized: ProviderPayload = { ...config };
  normalized.provider_type = canonicalizeProviderType(normalized.provider_type, normalized.api_mode);
  return normalized;
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
  if (rawProviderType === "rerank" || rawProviderType === "reranker" || rawProviderType === "rerank_api") {
    return "rerank_api";
  }
  return rawProviderType;
}

function labelProviderType(providerType: string): string {
  const labels: Record<string, string> = {
    openai_resp: "OpenAI Responses",
    openai_chat: "OpenAI Chat",
    openai_proxy: "OpenAI Compatible",
    rerank_api: "Rerank API",
  };
  return labels[providerType] ?? providerType.charAt(0).toUpperCase() + providerType.slice(1);
}

function makeProviderKey(config: Pick<ModelProviderConfig, "name" | "provider_type">): string {
  const name = String(config.name ?? "").trim().toLowerCase().replaceAll(" ", "_");
  const providerType = String(config.provider_type ?? "").trim().toLowerCase();
  return name && providerType ? `${name}_${providerType}` : "";
}

function rebuildModelsFromModelMap(config: ModelProviderConfig): void {
  const modelMap = normalizeModelMap(config.model_map);
  const fallbackModel = String(config.model ?? "").trim();
  const fallbackModels = normalizeModelValue(config.models);

  if (!Object.prototype.hasOwnProperty.call(modelMap, "chat") && fallbackModel) {
    modelMap.chat = fallbackModel;
  } else if (Object.keys(modelMap).length === 0 && fallbackModels) {
    modelMap.chat = fallbackModels;
  }

  config.model_map = modelMap;
  config.models = uniqueModelsFromMap(modelMap);
}

function normalizeModelMap(modelMap: unknown): ModelMap {
  if (!isRecord(modelMap)) {
    return {};
  }

  const normalized: ModelMap = {};
  for (const [task, value] of Object.entries(modelMap)) {
    const taskName = String(task ?? "").trim();
    if (!taskName) {
      continue;
    }
    const modelValue = normalizeModelValue(value);
    if (modelValue) {
      normalized[taskName] = modelValue;
    }
  }
  return normalized;
}

function normalizeModelValue(value: unknown): ModelMapValue | null {
  if (Array.isArray(value)) {
    const models: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      const model = String(item ?? "").trim();
      if (model && !seen.has(model)) {
        models.push(model);
        seen.add(model);
      }
    }
    return models.length ? models : null;
  }

  const model = String(value ?? "").trim();
  return model ? model : null;
}

function uniqueModelsFromMap(modelMap: ModelMap): string[] {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(modelMap)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const model = String(item ?? "").trim();
      if (model && !seen.has(model)) {
        models.push(model);
        seen.add(model);
      }
    }
  }
  return models;
}

function assignProviderField(config: ModelProviderConfig, field: (typeof UPDATE_FIELDS)[number], value: unknown): void {
  switch (field) {
    case "api_key":
      if (value === undefined) {
        delete config.api_key;
      } else {
        config.api_key = String(value ?? "");
      }
      break;
    case "temperature":
      setNumberField(config, "temperature", value);
      break;
    case "max_tokens":
      setNumberField(config, "max_tokens", value);
      break;
    case "max_completion_tokens":
      setNumberField(config, "max_completion_tokens", value);
      break;
    case "max_context_tokens":
      setNumberField(config, "max_context_tokens", value);
      break;
    case "thinking_budget_tokens":
      setNumberField(config, "thinking_budget_tokens", value);
      break;
    case "reasoning_effort":
      if (value === undefined) {
        delete config.reasoning_effort;
      } else {
        config.reasoning_effort = String(value ?? "");
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
    case "supports_function_calling":
      config.supports_function_calling = Boolean(value);
      break;
    case "model_map":
      config.model_map = normalizeModelMap(value);
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
    | "temperature"
    | "max_tokens"
    | "max_completion_tokens"
    | "max_context_tokens"
    | "thinking_budget_tokens"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
