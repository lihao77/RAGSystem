import type { ModelProviderConfig, ProviderPayload } from "../../contracts/integrations/model-adapter.js";
import { MODEL_MODALITIES, THINKING_STRENGTH_LEVELS, type ModelModality, type ThinkingStrengthLevel } from "../../contracts/integrations/model-adapter.js";
import { THINKING_KINDS_BY_FORMAT } from "@ragsystem/agent-llm";
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
    id: "provider_llm_engine_normalize",
    note: "llm_engine 非法值剔除（仅 pi-ai 合法，缺省/非法回落原生适配器）",
    run: normalizeLlmEngineStep,
  },
  {
    id: "provider_model_entries_normalize",
    note: "models 归一为对象条目数组（旧字符串条目/字符串模型名丢弃，只保留合法条目并去重；条目 thinking_kind 合法值归一）",
    run: normalizeModelEntriesStep,
  },
  {
    id: "provider_thinking_kind_sink",
    note: "厂商级 thinking_kind 下沉迁移：老形状（厂商值 + 可能为空的条目）按旧运行时语义等价固化进每条模型条目（含 toggle+子集升级 / anthropic 折叠 / 格式默认），随后剥离厂商字段",
    run: sinkThinkingKindStep,
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

/** 厂商思考形状合法值（与 agent-llm describeThinking 词表一致）。 */
const THINKING_KINDS = new Set(["effort", "budget", "toggle", "none"]);

/**
 * API 格式 × 思考形状能力矩阵：直接取 agent-llm 的单一事实源（THINKING_KINDS_BY_FORMAT，
 * 本层用于迁移落点与加载/写入校验），避免三份手工拷贝漂移。前端各持一份由测试字面量钉住。
 */


/** 旧运行时（推断退役前）的格式默认形状——迁移把该语义等价固化进条目。 */
const LEGACY_DEFAULT_KIND_BY_FORMAT: Readonly<Record<string, string>> = {
  anthropic: "budget",
  openai_chat: "effort",
  openai_resp: "effort",
};

/** LLM 委托引擎合法值（agent-llm 侧路由声明；缺省 = 原生适配器）。 */
const LLM_ENGINES = new Set(["pi-ai"]);

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
 * 运行时形态归一（create/update 写入面）：剥离已废弃的 provider 级字段、models 归一为
 * 模型条目数组。刻意不含 thinking_kind 下沉——写入面不填充形状（缺失/失配由
 * providerThinkingKindError 报 400），下沉迁移只归加载路径（runProviderFormNormalization）；
 * 退役的厂商级 thinking_kind 在此剥除（加载链由 sink 读完后自行剥离，不入本表防序干扰）。
 */
export function normalizeProviderRuntimeConfig(config: ModelProviderConfig): void {
  stripLegacyProviderFieldsStep(config);
  if (Object.prototype.hasOwnProperty.call(config, "thinking_kind")) {
    delete (config as Record<string, unknown>).thinking_kind;
  }
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

/**
 * 厂商级 thinking_kind 下沉迁移（形状驱动、幂等）：老形状 = 厂商值（或缺省）+ 可能未声明的条目。
 * 固化规则与旧运行时推断逐位等价——迁移前后行为不变：
 * - 起点值 = 厂商合法值 ?? 旧格式默认（anthropic budget / openai effort / 其余 none）；
 * - toggle + 条目 effort 子集 → effort（旧升级规则：子集是模型事实）；
 * - anthropic + toggle 无子集 → budget（旧折叠规则：保护真 Anthropic/未知端点）；
 * - openai + budget → none（旧 openai 线无预算通道，该覆盖本就不发参数——惰性等价）；
 * - gemini → none（思考走 thinkingConfig，kind 通道恒空）。
 * 全部条目已有声明时仅剥离厂商字段；新形态（无厂商字段）为 no-op。
 */
function sinkThinkingKindStep(config: ModelProviderConfig): boolean {
  const rawLegacy = (config as Record<string, unknown>).thinking_kind;
  const legacyKind = THINKING_KINDS.has(String(rawLegacy ?? "").trim().toLowerCase())
    ? String(rawLegacy).trim().toLowerCase()
    : null;
  const format = String(config.api_format ?? "").trim().toLowerCase();
  const allowed = THINKING_KINDS_BY_FORMAT[format];
  let changed = false;

  for (const entry of config.models ?? []) {
    if (entry.thinking_kind) continue;
    let kind: string = legacyKind ?? LEGACY_DEFAULT_KIND_BY_FORMAT[format] ?? "none";
    const hasSubset = Array.isArray(entry.thinking_levels) && entry.thinking_levels.length > 0;
    if (legacyKind === "toggle" && hasSubset) kind = "effort";
    if (format === "anthropic" && legacyKind === "toggle" && !hasSubset) kind = "budget";
    if (legacyKind === "none") kind = "none";
    // 落点必须落在格式能力矩阵内（openai+budget → none 惰性等价；gemini 恒 none）。
    // 本层 kind 词表是 string（agent-llm 矩阵按 ThinkingParamKind 收窄，此处按 string 消费）。
    if (allowed && !(allowed as readonly string[]).includes(kind)) kind = "none";
    entry.thinking_kind = kind;
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(config, "thinking_kind")) {
    delete (config as Record<string, unknown>).thinking_kind;
    changed = true;
  }
  return changed;
}

/**
 * 条目思考形状完整性校验（加载/写入面共用，报错不兜底）：
 * 每条模型必须显式声明合法且格式可达的 thinking_kind。返回 null = 通过；
 * 返回错误消息（含模型名与缺失/失配详情）= 该 provider 配置已损坏。
 */
export function providerThinkingKindError(config: ModelProviderConfig): string | null {
  const format = String(config.api_format ?? "").trim().toLowerCase();
  const allowed = THINKING_KINDS_BY_FORMAT[format];
  if (!allowed) {
    // 未知格式由 isChatProviderConfig/ensureProviderRequestShape 的封闭清单另行拦截
    return null;
  }
  for (const entry of config.models ?? []) {
    const kind = String(entry.thinking_kind ?? "").trim().toLowerCase();
    if (!kind) {
      return `模型 "${entry.name}" 缺少 thinking_kind 声明（thinking shape is required per model entry）`;
    }
    if (!THINKING_KINDS.has(kind)) {
      return `模型 "${entry.name}" 的 thinking_kind "${kind}" 非法（合法值: effort/budget/toggle/none）`;
    }
    if (!(allowed as readonly string[]).includes(kind)) {
      return `模型 "${entry.name}" 的 thinking_kind "${kind}" 在 API 格式 "${format}" 下不可用（可选: ${allowed.join("/")}）`;
    }
  }
  return null;
}

function normalizeLlmEngineStep(config: ModelProviderConfig): boolean {
  const before = config.llm_engine;
  const engine = String(before ?? "").trim().toLowerCase();
  if (engine && LLM_ENGINES.has(engine)) {
    config.llm_engine = engine;
  } else {
    delete config.llm_engine;
  }
  return before !== config.llm_engine;
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
    // 思考形状 trim/小写归一；非法值原样保留（缺失=迁移信号由 sink 收敛，非法值=
    // 配置损坏由 providerThinkingKindError 报错拦截——两类形状必须可区分）
    const thinkingKind = String(item.thinking_kind ?? "").trim().toLowerCase();
    if (thinkingKind) entry.thinking_kind = thinkingKind;
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
