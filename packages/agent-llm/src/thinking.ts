/**
 * 思考等级（thinking level）单一信源。
 *
 * 统一 UI 档位（off/minimal/low/medium/high/xhigh/max/on）→ 协议参数的映射。
 * 本包只认识通用形状（effort / budget / toggle / none）。思考形状是模型级显式声明：
 * 投影层把选中模型条目的 thinking_kind 合并进 provider（缺省回落厂商值——迁移后厂商
 * 级字段已退役，条目必达），本模块不做任何推断（格式默认表 / anthropic 折叠 /
 * toggle+子集升级均已退役）：缺失或与格式能力失配直接抛错（改坏了报错，不静默兜底）。
 * 档位只来自请求级 thinkingLevel / agent tier 默认档位；模型条目可带 thinking_levels
 * 强度子集（目录 reasoning_options 的 effort 值域）收缩可选档位。
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
 * toggle — 仅开关无分级（enable_thinking，qwen 系厂商经模型条目声明启用）；
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
 * provider 模型条目带入；off 是通用开关不入子集。effort/budget 形状受子集约束，
 * 预算按 BUDGET_BY_LEVEL 阶梯映射。
 */
export const THINKING_STRENGTH_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Anthropic budget_tokens 预算阶梯；off=0 → 不发 thinking 块，temperature 正常下发。
 * minimal/xhigh/max 只在模型子集出现时可选。
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
 * 格式 × 形状能力矩阵：本包适配器在该格式线上真能落线的形状集合。
 * 模型条目声明必须落在矩阵内（失配 = 配置损坏，抛错不静默）：anthropic 线
 * budget（原生 budget_tokens）/ effort（兼容网关 output_config.effort）；openai 线
 * effort（顶层 reasoning_effort）/ toggle（enable_thinking）；gemini 思考走
 * thinkingConfig（extra_params），kind 恒 none。
 */
export const THINKING_KINDS_BY_FORMAT: Readonly<Record<string, readonly ThinkingParamKind[]>> = {
  anthropic: ["budget", "effort", "none"],
  openai_chat: ["effort", "toggle", "none"],
  openai_resp: ["effort", "toggle", "none"],
  gemini: ["none"],
};

function normalizeKindOverride(value: unknown): ThinkingParamKind | null {
  return value === "effort" || value === "budget" || value === "toggle" || value === "none" ? value : null;
}

/**
 * 形状 → 可选档位（前端选择器按此渲染）。
 * 厂商特有的档位子集差异由其 API 兼容映射吸收（如 medium 映射 high），不再单列。
 */
const OPENAI_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const ANTHROPIC_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];
const TOGGLE_LEVELS: readonly ThinkingLevel[] = ["off", "on"];

function levelsFor(providerType: string, kind: ThinkingParamKind): readonly ThinkingLevel[] {
  if (kind === "budget") return ANTHROPIC_LEVELS;
  if (kind === "effort") return OPENAI_LEVELS;
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
 * 形状必须显式声明（投影层来自模型条目 thinking_kind）且落在格式能力矩阵内：
 * 缺失/非法/失配直接抛错（配置改坏了报错，不静默回落——历史推断规则
 * 【格式默认表 / anthropic 折叠 / toggle+子集升级】已退役，由 hydration 下沉迁移固化）。
 * 未知 API 格式返回 none（4 格式封闭清单在上游校验，此处不再抛错）。
 * levelsSubset 为模型级强度子集（目录 effort 值域）：effort/budget 形状下替换强度档位。
 */
export function describeThinking(
  providerType: string,
  kindOverride?: unknown,
  levelsSubset?: unknown,
): ThinkingCapability {
  const allowed = THINKING_KINDS_BY_FORMAT[providerType];
  if (!allowed) return { kind: "none", levels: [] };
  const kind = normalizeKindOverride(kindOverride);
  if (!kind) {
    // 缺失与非法分开口径（排障定位）：非法值带原文，缺失提示条目必达语义
    const raw = String(kindOverride ?? "").trim();
    if (raw) {
      throw new Error(`thinking_kind "${raw}" is invalid for "${providerType}" provider (valid: effort/budget/toggle/none)`);
    }
    throw new Error(`thinking_kind is missing for "${providerType}" provider (model entry must declare it explicitly)`);
  }
  if (!allowed.includes(kind)) {
    throw new Error(
      `thinking_kind "${kind}" is not expressible on "${providerType}" wire (allowed: ${allowed.join("/")})`,
    );
  }
  if (kind === "none") return { kind, levels: [] };
  if (kind === "toggle") return { kind, levels: TOGGLE_LEVELS };
  const levels = levelsFor(providerType, kind);
  return { kind, levels: applyModelLevelSubset(levels, levelsSubset) };
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

/** 模型条目 thinking_kind（投影层把选中模型条目的形状合并进 provider；厂商级字段已退役）。 */
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
