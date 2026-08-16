/**
 * 思考等级（thinking level）单一信源。
 *
 * 统一 UI 档位（off/low/medium/high）→ 各厂商协议参数的映射。档位如何落到请求 body 由本
 * 模块决定，是否支持由 describeThinking 按 provider_type 描述（provider YAML 的 thinking_kind
 * 字段可覆盖默认判定，如为 openrouter/deepseek 显式开启 effort）。显示文案/i18n 归前端，
 * 本模块只输出机器值。
 */

import type { ProviderConfig } from "./types.js";

/** 请求级思考档位（跨 provider 统一 key；undefined/null = 跟随 provider 配置）。 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** 思考参数落到请求的方式：OpenAI 系 effort 枚举 / Anthropic token 预算 / 不支持。 */
export type ThinkingParamKind = "effort" | "budget" | "none";

export interface ThinkingCapability {
  kind: ThinkingParamKind;
  /** 可选档位（kind=none 时为空数组，UI 应隐藏选择器）。 */
  levels: readonly ThinkingLevel[];
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

/** off 映射为厂商侧"显式关闭"值（OpenAI effort=none），与"不发参数"（模型默认）区分。 */
const EFFORT_BY_LEVEL: Readonly<Record<ThinkingLevel, string>> = {
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
};

/** Anthropic budget_tokens 预设；off=0 → 不发 thinking 块，temperature 正常下发。 */
const BUDGET_BY_LEVEL: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 4096,
  medium: 16384,
  high: 32768,
};

/**
 * provider_type 默认思考能力。openai 系三家走 effort；anthropic 走 budget。
 * deepseek/openrouter/modelscope 的思考由模型本身或厂商私有参数决定（非标准 effort 字段），
 * 默认 none——如确需启用，provider YAML 写 thinking_kind: effort 覆盖。
 */
const THINKING_KIND_BY_PROVIDER_TYPE: Readonly<Record<string, ThinkingParamKind>> = {
  openai_resp: "effort",
  openai_chat: "effort",
  openai_proxy: "effort",
  anthropic: "budget",
  deepseek: "none",
  openrouter: "none",
  modelscope: "none",
  rerank_api: "none",
};

function normalizeKindOverride(value: unknown): ThinkingParamKind | null {
  return value === "effort" || value === "budget" || value === "none" ? value : null;
}

/** 描述某 provider 的思考能力；前端选择器据此决定显隐与可选档位。 */
export function describeThinking(providerType: string, kindOverride?: unknown): ThinkingCapability {
  const kind = normalizeKindOverride(kindOverride) ?? THINKING_KIND_BY_PROVIDER_TYPE[providerType] ?? "none";
  return { kind, levels: kind === "none" ? [] : THINKING_LEVELS };
}

/** 统一档位 → 厂商参数；类型不支持思考时返回 null（调用方应丢弃覆盖）。 */
export function resolveThinkingParams(
  level: ThinkingLevel,
  providerType: string,
  kindOverride?: unknown,
): { reasoning_effort?: string; thinking_budget_tokens?: number } | null {
  const { kind } = describeThinking(providerType, kindOverride);
  if (kind === "none") return null;
  return kind === "effort"
    ? { reasoning_effort: EFFORT_BY_LEVEL[level] }
    : { thinking_budget_tokens: BUDGET_BY_LEVEL[level] };
}

function kindOverrideOf(provider: ProviderConfig): unknown {
  return (provider as Record<string, unknown>).thinking_kind;
}

/** LlmRequest.thinkingLevel 生效 effort：请求级档位优先，回落 provider.reasoning_effort。 */
export function effectiveReasoningEffort(provider: ProviderConfig, level?: ThinkingLevel | null): string | undefined {
  if (level) {
    return resolveThinkingParams(level, provider.provider_type, kindOverrideOf(provider))?.reasoning_effort;
  }
  const value = provider.reasoning_effort;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * LlmRequest.thinkingLevel 生效 thinking 预算：请求级档位优先，回落 provider.thinking_budget_tokens。
 * 返回 undefined = 不启用思考；0 = 档位显式关闭（等价不启用，由 anthropic 适配器的 >0 判定兜住）。
 */
export function effectiveThinkingBudget(provider: ProviderConfig, level?: ThinkingLevel | null): number | undefined {
  if (level) {
    return resolveThinkingParams(level, provider.provider_type, kindOverrideOf(provider))?.thinking_budget_tokens;
  }
  const value = provider.thinking_budget_tokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
