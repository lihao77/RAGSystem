/**
 * 思考等级（thinking level）单一信源。
 *
 * 统一 UI 档位（off/minimal/low/medium/high/xhigh/max/on）→ 各厂商协议参数的映射。
 * 档位如何落到请求 body 由本模块决定（buildThinkingParams 按 provider_type 分派），是否
 * 支持由 describeThinking 按 provider_type 描述（provider YAML 的 thinking_kind 字段可
 * 覆盖默认判定）。档位只来自请求级 thinkingLevel / agent tier 默认档位，provider 自身不
 * 定义思考强度。显示文案/i18n 归前端，本模块只输出机器值。
 */

import type { ProviderConfig } from "./types.js";

/**
 * 请求级思考档位（跨 provider 统一 key；undefined/null = 未决，由 agent tier 默认档位兜底）。
 * 档位集合按厂商不同（见 THINKING_LEVELS_BY_PROVIDER_TYPE）：effort 系用
 * minimal/low/medium/high（deepseek 为 low/high/max，openrouter 额外含 xhigh），
 * toggle 系仅 off/on，off 在所有系均表示显式关闭。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "on";

/** 全部已知档位（投影层校验 tier.thinking_level / 请求级档位合法性用）。 */
export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "on"];

/**
 * 思考参数落到请求的方式：
 * effort — 推理强度枚举（OpenAI 顶层 reasoning_effort；deepseek 包在 thinking map；openrouter 包在 reasoning map）；
 * budget — Anthropic token 预算（由 anthropic 适配器单独消费，buildThinkingParams 不产出）；
 * toggle — 仅开关无分级（ModelScope/Qwen 系 enable_thinking）；
 * none — 不支持。
 */
export type ThinkingParamKind = "effort" | "budget" | "toggle" | "none";

export interface ThinkingCapability {
  kind: ThinkingParamKind;
  /** 可选档位（kind=none 时为空数组，UI 应隐藏选择器）。 */
  levels: readonly ThinkingLevel[];
}

/** effort 系档位直通值（off 由各厂商序列化显式处理；on 仅 toggle 系使用）。 */
const EFFORT_BY_LEVEL: Readonly<Record<Exclude<ThinkingLevel, "off" | "on">, string>> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** Anthropic budget_tokens 预设；off=0 → 不发 thinking 块，temperature 正常下发。 */
const BUDGET_BY_LEVEL: Readonly<Partial<Record<ThinkingLevel, number>>> = {
  off: 0,
  low: 4096,
  medium: 16384,
  high: 32768,
};

/**
 * provider_type 默认思考能力。openai 系三家走 effort；anthropic 走 budget；
 * deepseek 官方 API 用 thinking map 包 effort（off 显式 disabled）；openrouter 用 reasoning map；
 * modelscope/qwen 系仅 enable_thinking 开关。rerank_api 无 chat 能力。
 */
const THINKING_KIND_BY_PROVIDER_TYPE: Readonly<Record<string, ThinkingParamKind>> = {
  openai_resp: "effort",
  openai_chat: "effort",
  openai_proxy: "effort",
  anthropic: "budget",
  mistral: "effort",
  groq: "effort",
  qwen: "toggle",
  deepseek: "effort",
  openrouter: "effort",
  modelscope: "toggle",
  rerank_api: "none",
};

function normalizeKindOverride(value: unknown): ThinkingParamKind | null {
  return value === "effort" || value === "budget" || value === "toggle" || value === "none" ? value : null;
}

/**
 * provider_type → 可选档位（describeThinking 据此返回，前端选择器按此渲染）。
 * 反映各厂商官方枚举：openai 系 minimal..high；deepseek 官方仅 low/high/max
 * （medium/xhigh 被其 API 兼容映射到 high，故不暴露）；openrouter 全枚举含 xhigh；
 * anthropic budget 预设档；modelscope 仅开关。未知类型回退 kind 通用表。
 */
const OPENAI_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const DEEPSEEK_LEVELS: readonly ThinkingLevel[] = ["off", "low", "high", "max"];
const OPENROUTER_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const ANTHROPIC_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];
const TOGGLE_LEVELS: readonly ThinkingLevel[] = ["off", "on"];

const THINKING_LEVELS_BY_PROVIDER_TYPE: Readonly<Record<string, readonly ThinkingLevel[]>> = {
  openai_resp: OPENAI_LEVELS,
  openai_chat: OPENAI_LEVELS,
  openai_proxy: OPENAI_LEVELS,
  anthropic: ANTHROPIC_LEVELS,
  mistral: ["off", "minimal", "low", "medium", "high", "xhigh"],
  groq: ["off", "on", "low", "medium", "high"],
  qwen: TOGGLE_LEVELS,
  deepseek: DEEPSEEK_LEVELS,
  openrouter: OPENROUTER_LEVELS,
  modelscope: TOGGLE_LEVELS,
};

function levelsFor(providerType: string, kind: ThinkingParamKind): readonly ThinkingLevel[] {
  const byProvider = THINKING_LEVELS_BY_PROVIDER_TYPE[providerType];
  if (byProvider) return byProvider;
  if (kind === "toggle") return TOGGLE_LEVELS;
  if (kind === "effort") return OPENAI_LEVELS;
  return [];
}

/** 描述某 provider 的思考能力；前端选择器据此决定显隐与可选档位。 */
export function describeThinking(providerType: string, kindOverride?: unknown): ThinkingCapability {
  const kind = normalizeKindOverride(kindOverride) ?? THINKING_KIND_BY_PROVIDER_TYPE[providerType] ?? "none";
  return { kind, levels: kind === "none" ? [] : levelsFor(providerType, kind) };
}

/** 档位必须落在 provider 声明子集内（陈旧 tier 配置/外部请求不得静默下发越界值）。 */
function requireSupportedLevel(level: ThinkingLevel, levels: readonly ThinkingLevel[], providerType: string): void {
  if (!levels.includes(level)) {
    throw new Error(`thinking level "${level}" is not supported by provider type "${providerType}" (available: ${levels.join("/")})`);
  }
}

/**
 * 统一档位 → 扁平厂商参数（openai 系顶层 reasoning_effort / anthropic thinking_budget_tokens）；
 * deepseek/openrouter 的嵌套形状由 buildThinkingParams 处理，不走本函数。类型不支持时返回 null。
 */
export function resolveThinkingParams(
  level: ThinkingLevel,
  providerType: string,
  kindOverride?: unknown,
): { reasoning_effort?: string; thinking_budget_tokens?: number } | null {
  const { kind, levels } = describeThinking(providerType, kindOverride);
  if (kind === "none") return null;
  requireSupportedLevel(level, levels, providerType);
  if (kind === "effort") {
    if (providerType === "groq" && level === "on") return { reasoning_effort: "default" };
    return { reasoning_effort: level === "off" ? "none" : EFFORT_BY_LEVEL[level as Exclude<ThinkingLevel, "off" | "on">] };
  }
  const budget = BUDGET_BY_LEVEL[level];
  return { ...(budget !== undefined ? { thinking_budget_tokens: budget } : {}) };
}

function kindOverrideOf(provider: ProviderConfig): unknown {
  return (provider as Record<string, unknown>).thinking_kind;
}

/**
 * 请求级思考档位 → 可直接合并进 chat 请求 body 的厂商参数（按 provider_type 分派）。
 * 无档位（undefined/null）返回 null——档位只来自请求级 thinkingLevel / agent tier 默认档位，
 * provider 自身不定义思考强度。kind 为 none/budget 也返回 null（budget 由 anthropic 适配器
 * 走 effectiveThinkingBudget，temperature/推理块回传逻辑在那边）。off 对 effort 系 = 厂商
 * 侧显式关闭（openai 顶层 none / openrouter reasoning.none / deepseek thinking.disabled）。
 */
export function buildThinkingParams(
  provider: ProviderConfig,
  level?: ThinkingLevel | null,
): Record<string, unknown> | null {
  if (!level) return null;
  const { kind, levels } = describeThinking(provider.provider_type, kindOverrideOf(provider));
  if (kind === "none" || kind === "budget") return null;
  requireSupportedLevel(level, levels, provider.provider_type);
  const providerType = provider.provider_type;
  if (kind === "toggle") {
    return { enable_thinking: level !== "off" };
  }
  if (providerType === "groq" && level === "on") {
    return { reasoning_effort: "default" };
  }
  if (level === "off") {
    if (providerType === "deepseek") return { thinking: { type: "disabled" } };
    if (providerType === "openrouter") return { reasoning: { effort: "none" } };
    return { reasoning_effort: "none" };
  }
  const effort = EFFORT_BY_LEVEL[level as Exclude<ThinkingLevel, "off" | "on">];
  if (!effort) return null;
  if (providerType === "deepseek") {
    return { thinking: { type: "enabled", reasoning_effort: effort } };
  }
  if (providerType === "openrouter") return { reasoning: { effort } };
  return { reasoning_effort: effort };
}

/** LlmRequest.thinkingLevel 生效 effort（openai responses 路径）；无档位 = 不发送。 */
export function effectiveReasoningEffort(provider: ProviderConfig, level?: ThinkingLevel | null): string | undefined {
  if (!level) return undefined;
  return resolveThinkingParams(level, provider.provider_type, kindOverrideOf(provider))?.reasoning_effort;
}

/**
 * LlmRequest.thinkingLevel 生效 thinking 预算（anthropic 路径）；无档位 = 不启用。
 * 0 = 档位显式关闭（等价不启用，由 anthropic 适配器的 >0 判定兜住）。
 */
export function effectiveThinkingBudget(provider: ProviderConfig, level?: ThinkingLevel | null): number | undefined {
  if (!level) return undefined;
  return resolveThinkingParams(level, provider.provider_type, kindOverrideOf(provider))?.thinking_budget_tokens;
}
