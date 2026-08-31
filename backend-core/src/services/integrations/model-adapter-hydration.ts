import type { ModelProviderConfig, ProviderPayload } from "../../contracts/integrations/model-adapter.js";
import { MODEL_MODALITIES, THINKING_STRENGTH_LEVELS, type ModelModality, type ThinkingStrengthLevel } from "../../contracts/integrations/model-adapter.js";
import { isRecord } from "../../utils/guards.js";
import type { HydrationStep } from "../config/hydration.js";

/**
 * Provider 配置的形态归一层（永久步骤，非可退役迁移）：loadProvidersFromDisk 与
 * replaceRuntimeProviders 共用同一组步骤，同时被 create/update 路径复用
 * （canonicalizeProviderConfig / normalizeProviderRuntimeConfig）。它保证内存与
 * 磁盘上的 provider 恒为新形态；没有应用戳——每次加载都要重跑，不存在"治理完成后
 * 不再需要"的终态。步骤登记见 backend-core/MIGRATIONS.md「形态归一层」一节。
 */
export const PROVIDER_FORM_NORMALIZATION_STEPS: readonly HydrationStep<ModelProviderConfig>[] = [
  {
    id: "provider_api_format_alias_canonicalize",
    note: "provider_type trim/小写 + api_format 旧别名归一（openai_compatible_chat/openai_proxy → openai_chat 等）",
    run: canonicalizeApiFormatStep,
  },
  {
    id: "provider_legacy_field_strip",
    note: "剥离已下沉到模型条目/厂商目录的 provider 级废弃字段（model/model_map/temperature 等）",
    run: stripLegacyProviderFieldsStep,
  },
  {
    id: "provider_thinking_kind_normalize",
    note: "thinking_kind 非法值剔除（回落格式默认思考形状）",
    run: normalizeThinkingKindStep,
  },
  {
    id: "provider_model_entries_normalize",
    note: "models 归一为对象条目数组（旧字符串条目/字符串模型名丢弃，只保留合法条目并去重）",
    run: normalizeModelEntriesStep,
  },
];

/** 就地执行形态归一链（变更检测仅供链内核使用，本层无应用戳）。 */
export function runProviderFormNormalization(config: ModelProviderConfig): void {
  for (const step of PROVIDER_FORM_NORMALIZATION_STEPS) {
    step.run(config);
  }
}

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

/** 厂商思考形状合法值（透传 agent-llm describeThinking 覆盖）。 */
const THINKING_KINDS = new Set(["effort", "budget", "toggle", "none"]);

export function canonicalizeProviderConfig(config: ProviderPayload): ProviderPayload {
  const normalized: ProviderPayload = { ...config };
  // provider_type = 厂商（自由字符串，仅归一大小写/空白）；API 格式别名归一只作用于 api_format。
  normalized.provider_type = String(normalized.provider_type ?? "").trim().toLowerCase();
  normalized.api_format = canonicalizeProviderType(normalized.api_format, normalized.api_mode);
  return normalized;
}

/** chat provider 有效 = 厂商非空 + API 格式在 kernel 封闭清单（水合/加载过滤用）。 */
export function isChatProviderConfig(
  config: ModelProviderConfig,
  isKnownApiFormat: (apiFormat: string) => boolean,
): boolean {
  return Boolean(String(config.provider_type ?? "").trim())
    && isKnownApiFormat(String(config.api_format ?? "").trim().toLowerCase());
}

export function canonicalizeProviderType(providerType: unknown, apiMode: unknown): string {
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
  // openai_proxy（兼容网关档位）已并入 openai_chat：官方差异由端点/能力位守卫处理，存量条目别名归一。
  if (rawProviderType === "openai_compatible_chat" || rawProviderType === "openai_proxy") {
    return "openai_chat";
  }
  return rawProviderType;
}

/**
 * 运行时形态归一：剥离已废弃的 provider 级字段（模型映射/运行参数），models 归一为模型条目数组。
 * create/update/load/replaceRuntime 四个入口共用，保证内存与磁盘上的 provider 恒为新形态。
 */
export function normalizeProviderRuntimeConfig(config: ModelProviderConfig): void {
  stripLegacyProviderFieldsStep(config);
  normalizeThinkingKindStep(config);
  normalizeModelEntriesStep(config);
}

function canonicalizeApiFormatStep(config: ModelProviderConfig): boolean {
  const before = `${String(config.provider_type ?? "")}\u0000${String(config.api_format ?? "")}`;
  // api_mode 是 load 路径的旧 payload 键：canonicalizeProviderConfig 通常已消费，
  // 这里读 config 上的残留值。行为说明：磁盘水合路径历来如此；replaceRuntime 路径
  // 旧版显式传 undefined，链化后统一消费残留 api_mode——携带 api_mode:"responses" +
  // api_format:"openai" 的运行时快照条目会归一为 openai_resp 而非 openai_chat，
  // 这是两条路径水合口径统一的既定意图。
  const apiMode = (config as unknown as Record<string, unknown>).api_mode;
  config.provider_type = String(config.provider_type ?? "").trim().toLowerCase();
  config.api_format = canonicalizeProviderType(config.api_format, apiMode);
  return before !== `${config.provider_type}\u0000${String(config.api_format ?? "")}`;
}

function stripLegacyProviderFieldsStep(config: ModelProviderConfig): boolean {
  let changed = false;
  for (const field of LEGACY_PROVIDER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(config, field)) {
      delete config[field];
      changed = true;
    }
  }
  return changed;
}

function normalizeThinkingKindStep(config: ModelProviderConfig): boolean {
  const before = config.thinking_kind;
  const thinkingKind = String(before ?? "").trim().toLowerCase();
  // thinking_kind 非法值静默剔除（回落格式默认形状）：形状声明是增强项，拼写错误不应阻断
  // 连接配置；对比 api_format 是封闭枚举、直接 400。
  if (thinkingKind && THINKING_KINDS.has(thinkingKind)) {
    config.thinking_kind = thinkingKind;
  } else {
    delete config.thinking_kind;
  }
  return before !== config.thinking_kind;
}

function normalizeModelEntriesStep(config: ModelProviderConfig): boolean {
  const before = JSON.stringify(config.models);
  config.models = normalizeModels(config.models);
  return before !== JSON.stringify(config.models);
}

/** 模型条目数组归一：只保留已知键，name trim 非空去重，数值/布尔/模态非法值丢弃；非数组 → []。 */
export function normalizeModels(value: unknown): ModelProviderConfig["models"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const models: ModelProviderConfig["models"] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = String(item.name ?? "").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    const entry: ModelProviderConfig["models"][number] = { name };
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

function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}
