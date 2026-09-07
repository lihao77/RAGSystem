/**
 * 思考等级（thinking level）单一信源。
 *
 * 统一 UI 档位（off/minimal/low/medium/high/xhigh/max/on）→ 协议参数的映射。
 * 本包只认识通用形状（effort / budget / toggle / none），按 API 格式给默认值；
 * 厂商适配在 provider 层声明——thinking_kind 覆盖形状（如 qwen 系 enable_thinking），
 * 静态厂商参数经 extra_params 进请求体（如嵌套 thinking map）。档位只来自请求级
 * thinkingLevel / agent tier 默认档位，provider 自身不定义思考强度；模型条目可带
 * thinking_levels 强度子集（目录 reasoning_options 的 effort 值域）收缩可选档位，
 * 子集在场即模型事实——toggle 厂商（如智谱多数 GLM）下带值域的模型按 effort 分级。
 * anthropic 格式默认折叠为 budget（原生线上只有 budget_tokens 一个参数）；显式
 * thinking_kind: effort 例外保留——它是 effort 型兼容端点（智谱/Kimi/阿里/火山等
 * /v1/messages 网关：预算被无视、只认 output_config.effort 档位）的 opt-in；
 * toggle + 模型 effort 子集同样升级 effort（openai 原生厂商挂 anthropic 端点必是
 * 兼容层，档位制），由 anthropic 适配器发档位字段（见 buildAnthropicBody）。
 * 显示文案/i18n 归前端，本模块只输出机器值。
 */

import type { ProviderConfig } from "./types.js";

/**
 * 请求级思考档位（跨 provider 统一 key；undefined/null = 未决，由 agent tier 默认档位兜底）。
 * 档位集合按形状不同：effort 系用 minimal/low/medium/high，toggle 系仅 off/on，
 * off 在所有系均表示显式关闭。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "on";

/** 全部已知档位（投影层校验 tier.thinking_level / 请求级档位合法性用）。 */
export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "on"];

/**
 * 思考参数落到请求的方式（通用形状，与厂商无关）：
 * effort — 推理强度枚举（openai 系顶层 reasoning_effort；anthropic 兼容端点落
 *   output_config.effort，由 anthropic 适配器消费）；厂商自有的嵌套形状经 extra_params 声明；
 * budget — Anthropic token 预算（由 anthropic 适配器单独消费，buildThinkingParams 不产出）；
 * toggle — 仅开关无分级（enable_thinking，qwen 系厂商经 provider thinking_kind 声明启用）；
 * none — 不支持。
 */
export type ThinkingParamKind = "effort" | "budget" | "toggle" | "none";

export interface ThinkingCapability {
  kind: ThinkingParamKind;
  /** 可选档位（kind=none 时为空数组，UI 应隐藏选择器）。 */
  levels: readonly ThinkingLevel[];
}

/** effort 系档位直通值（off 由各形状序列化显式处理；on 仅 toggle 系使用）。 */
const EFFORT_BY_LEVEL: Readonly<Record<Exclude<ThinkingLevel, "off" | "on">, string>> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * effort 系强度档位全集（模型级子集 thinking_levels 的合法值域）。
 * 子集来自目录厂商声明（models.dev reasoning_options 的 effort 值域），经
 * provider 模型条目带入；off 是通用开关不入子集。effort 形状受子集约束，toggle
 * 形状下非空子集直接升级为 effort 分级，budget 形状（anthropic 线）菜单同样随
 * 子集收缩、预算按 BUDGET_BY_LEVEL 阶梯映射。
 */
export const THINKING_STRENGTH_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Anthropic budget_tokens 预算阶梯；off=0 → 不发 thinking 块，temperature 正常下发。
 * minimal/xhigh/max 覆盖目录 effort 值域经 anthropic 折叠后的档位落点——budget 默认
 * 菜单（ANTHROPIC_LEVELS）仍不含它们，只在模型子集出现时可选。
 */
const BUDGET_BY_LEVEL: Readonly<Partial<Record<ThinkingLevel, number>>> = {
  off: 0,
  low: 4096,
  medium: 16384,
  high: 32768,
  minimal: 2048,
  xhigh: 49152,
  max: 65536,
};

/**
 * API 格式默认思考形状。openai 系三家走 effort；anthropic 走 budget；gemini 默认 none。
 * 厂商差异（qwen 系 enable_thinking 等）由 provider YAML 的 thinking_kind 覆盖，
 * 本表不出现任何厂商名。
 */
const THINKING_KIND_BY_PROVIDER_TYPE: Readonly<Record<string, ThinkingParamKind>> = {
  openai_resp: "effort",
  openai_chat: "effort",
  anthropic: "budget",
};

function normalizeKindOverride(value: unknown): ThinkingParamKind | null {
  return value === "effort" || value === "budget" || value === "toggle" || value === "none" ? value : null;
}

/**
 * API 格式 → 可选档位（describeThinking 据此返回，前端选择器按此渲染）。
 * 厂商特有的档位子集差异由其 API 兼容映射吸收（如 medium 映射 high），不再单列。
 */
const OPENAI_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const ANTHROPIC_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];
const TOGGLE_LEVELS: readonly ThinkingLevel[] = ["off", "on"];

const THINKING_LEVELS_BY_PROVIDER_TYPE: Readonly<Record<string, readonly ThinkingLevel[]>> = {
  openai_resp: OPENAI_LEVELS,
  openai_chat: OPENAI_LEVELS,
  anthropic: ANTHROPIC_LEVELS,
};

function levelsFor(providerType: string, kind: ThinkingParamKind): readonly ThinkingLevel[] {
  // budget 默认菜单取预设阶梯的基准集；模型子集的收缩在 describeThinking 统一做
  //（applyModelLevelSubset 对 effort/budget 同型）。openai 系被 budget 覆盖时同理。
  // effort 形状无论格式都走 effort 阶梯（anthropic 显式 effort 声明同样有 minimal 档）。
  if (kind === "budget") return ANTHROPIC_LEVELS;
  if (kind === "effort") return OPENAI_LEVELS;
  const byProvider = THINKING_LEVELS_BY_PROVIDER_TYPE[providerType];
  if (byProvider && kind !== "toggle") return byProvider;
  if (kind === "toggle") return TOGGLE_LEVELS;
  return [];
}

/**
 * 模型级强度子集（provider.thinking_levels）归一：子集来自目录厂商枚举
 * （models.dev reasoning_options 的 effort 值域），是模型真实值域，可含格式默认集
 * 没有的档位（如 max）。过滤到已知强度档位并按全集顺序输出；空/缺省/全非法 = []。
 */
function normalizeStrengthSubset(subset: unknown): readonly ThinkingLevel[] {
  if (!Array.isArray(subset) || subset.length === 0) {
    return [];
  }
  const known = new Set<string>(THINKING_STRENGTH_LEVELS);
  const picked = new Set<string>();
  for (const item of subset) {
    const token = String(item ?? "").trim().toLowerCase();
    if (known.has(token)) {
      picked.add(token);
    }
  }
  return THINKING_STRENGTH_LEVELS.filter((level) => picked.has(level));
}

/**
 * effort/budget 形状的模型级子集替换强度档位：off 是通用开关恒保留；
 * 空/缺省/全非法 = 不限制（用格式默认集）。
 */
function applyModelLevelSubset(levels: readonly ThinkingLevel[], subset: unknown): readonly ThinkingLevel[] {
  const picked = normalizeStrengthSubset(subset);
  return picked.length ? ["off", ...picked] : levels;
}

/**
 * 描述某 provider 的思考能力；前端选择器据此决定显隐与可选档位。
 * levelsSubset 为模型级强度子集（目录 effort 值域）：effort 形状下替换强度档位；
 * toggle 形状下非空子集是模型事实（厂商投票只描述多数默认，如智谱 glm-5.3 的
 * low/high/max 分级），升级为 effort 形状。anthropic 格式默认折叠为 budget
 * （原生线上只有 budget_tokens 一个思考参数），两个例外保留 effort：显式 effort
 * 声明——effort 型兼容端点（智谱/Kimi/阿里/火山等 /v1/messages 网关，
 * budget_tokens 被无视）的 opt-in；toggle + 模型 effort 子集自动升级——openai
 * 原生厂商挂 anthropic 端点必是兼容层，与 openai 的升级规则同型。
 */
export function describeThinking(
  providerType: string,
  kindOverride?: unknown,
  levelsSubset?: unknown,
): ThinkingCapability {
  let kind = normalizeKindOverride(kindOverride) ?? THINKING_KIND_BY_PROVIDER_TYPE[providerType] ?? "none";
  if (kind === "none") return { kind, levels: [] };
  // anthropic 线上原生只有 thinking.budget_tokens 一个思考参数（官方亦无 effort 枚举），
  // 默认折叠为 budget 保护真 Anthropic/未知端点。两个例外保留 effort（适配器发
  // output_config.effort）：显式 effort 声明（effort 型兼容端点 opt-in）；toggle + 模型
  // effort 子集自动升级——toggle 声明只可能来自 openai 原生厂商的目录投票，该类厂商挂
  // anthropic 端点必是兼容层（智谱/Kimi/阿里/火山等，budget_tokens 被无视、清一色档位制），
  // 与 openai 格式的 toggle+子集升级同型。显式 none 已在上面短路。
  if (providerType === "anthropic" && kind !== "effort") {
    const toggleUpgrade = kind === "toggle" && normalizeStrengthSubset(levelsSubset).length > 0;
    if (!toggleUpgrade) kind = "budget";
  }
  if (kind === "toggle") {
    const picked = normalizeStrengthSubset(levelsSubset);
    if (picked.length) return { kind: "effort", levels: ["off", ...picked] };
    return { kind, levels: TOGGLE_LEVELS };
  }
  const levels = levelsFor(providerType, kind);
  return { kind, levels: kind === "effort" || kind === "budget" ? applyModelLevelSubset(levels, levelsSubset) : levels };
}

/** 档位必须落在 provider 声明子集内（陈旧 tier 配置/外部请求不得静默下发越界值）。 */
function requireSupportedLevel(level: ThinkingLevel, levels: readonly ThinkingLevel[], providerType: string): void {
  if (!levels.includes(level)) {
    throw new Error(`thinking level "${level}" is not supported by provider type "${providerType}" (available: ${levels.join("/")})`);
  }
}

/**
 * 统一档位 → 扁平厂商参数（openai 系顶层 reasoning_effort / anthropic thinking_budget_tokens）；
 * 类型不支持时返回 null。厂商嵌套形状经 provider extra_params 声明，不走本函数。
 */
export function resolveThinkingParams(
  level: ThinkingLevel,
  providerType: string,
  kindOverride?: unknown,
  levelsSubset?: unknown,
): { reasoning_effort?: string; thinking_budget_tokens?: number } | null {
  const { kind, levels } = describeThinking(providerType, kindOverride, levelsSubset);
  if (kind === "none") return null;
  requireSupportedLevel(level, levels, providerType);
  if (kind === "effort") {
    if (level === "off") return { reasoning_effort: "none" };
    const effort = EFFORT_BY_LEVEL[level as Exclude<ThinkingLevel, "off" | "on">];
    return effort ? { reasoning_effort: effort } : null;
  }
  const budget = BUDGET_BY_LEVEL[level];
  return { ...(budget !== undefined ? { thinking_budget_tokens: budget } : {}) };
}

function kindOverrideOf(provider: ProviderConfig): unknown {
  return (provider as Record<string, unknown>).thinking_kind;
}

/**
 * 思考专属副作用（历史补齐 reasoning 字段等）是否激活：要求档位显式开启且形状
 * 真的会产出请求参数（effort/toggle）。kind=none 或 budget 覆盖到 openai 系时
 * 请求体没有思考参数，陈旧档位不得触发补齐（避免向无思考通道的请求注入未知字段）。
 */
export function thinkingSideEffectsActive(provider: ProviderConfig, level?: ThinkingLevel | null): boolean {
  if (!level || level === "off") {
    return false;
  }
  const { kind } = describeThinking(provider.provider_type, kindOverrideOf(provider));
  return kind === "effort" || kind === "toggle";
}

/** 模型级强度档位子集（投影层把选中模型条目的 thinking_levels 合并进 provider）。 */
function levelsSubsetOf(provider: ProviderConfig): unknown {
  return (provider as Record<string, unknown>).thinking_levels;
}

/**
 * 请求级思考档位 → 可直接合并进 chat 请求 body 的参数（按通用形状分派，与厂商无关）。
 * 无档位（undefined/null）返回 null——档位只来自请求级 thinkingLevel / agent tier 默认档位，
 * provider 自身不定义思考强度。kind 为 none/budget 也返回 null（budget 由 anthropic 适配器
 * 走 effectiveThinkingBudget，temperature/推理块回传逻辑在那边）。off 对 effort 系 = 厂商
 * 侧显式关闭（顶层 none）；toggle 系为 enable_thinking:false。
 */
export function buildThinkingParams(
  provider: ProviderConfig,
  level?: ThinkingLevel | null,
): Record<string, unknown> | null {
  if (!level) return null;
  const { kind, levels } = describeThinking(provider.provider_type, kindOverrideOf(provider), levelsSubsetOf(provider));
  if (kind === "none" || kind === "budget") return null;
  requireSupportedLevel(level, levels, provider.provider_type);
  if (kind === "toggle") {
    return { enable_thinking: level !== "off" };
  }
  if (level === "off") return { reasoning_effort: "none" };
  const effort = EFFORT_BY_LEVEL[level as Exclude<ThinkingLevel, "off" | "on">];
  return effort ? { reasoning_effort: effort } : null;
}

/** LlmRequest.thinkingLevel 生效 effort（openai responses 路径 + anthropic effort 型兼容端点）；无档位 = 不发送。 */
export function effectiveReasoningEffort(provider: ProviderConfig, level?: ThinkingLevel | null): string | undefined {
  if (!level) return undefined;
  return resolveThinkingParams(level, provider.provider_type, kindOverrideOf(provider), levelsSubsetOf(provider))?.reasoning_effort;
}

/**
 * LlmRequest.thinkingLevel 生效 thinking 预算（anthropic 路径）；无档位 = 不启用。
 * 0 = 档位显式关闭（等价不启用，由 anthropic 适配器的 >0 判定兜住）。
 */
export function effectiveThinkingBudget(provider: ProviderConfig, level?: ThinkingLevel | null): number | undefined {
  if (!level) return undefined;
  return resolveThinkingParams(level, provider.provider_type, kindOverrideOf(provider), levelsSubsetOf(provider))?.thinking_budget_tokens;
}
