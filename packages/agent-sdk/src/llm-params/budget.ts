/**
 * 上下文预算 —— 纯算术（设计稿 §9）。
 *
 * 投影算死的 tiers.default 已决值 + CompressionBudgetConfig（默认参数）做纯算术，
 * 无多源兜底。预算 = provider 最大上下文按系数缩放，减去 prompt 与补全预留，clamp 到下限。
 */
import type { CompressionBudgetConfig, TierMap } from "../types.js";
import { DEFAULT_COMPRESSION_BUDGET } from "../types.js";

export function resolveContextBudget(
  tiers: TierMap,
  config: CompressionBudgetConfig = DEFAULT_COMPRESSION_BUDGET,
): number {
  // 契约：tiers.default 恒在（投影保证，§3 契约约束）。
  const defaultTier = tiers.default ?? assertDefault(tiers);
  const contextWindow = defaultTier.maxContextTokens;
  const maxCompletionTokens = defaultTier.maxCompletionTokens;
  // 无 maxContextTokens 时：补全预留 * 兜底倍数，clamp 到下限（避免 contextWindow 缺值时算出负数）。
  if (contextWindow === null) {
    const fallback = Math.floor((maxCompletionTokens ?? 0) * 3);
    return Math.max(fallback, config.minContextBudget);
  }
  const budget =
    Math.floor(contextWindow * config.contextWindowSafetyFactor)
    - config.systemPromptReserve
    - (maxCompletionTokens ?? 0);
  return Math.max(budget, config.minContextBudget);
}

/** 契约守卫：default 档必填（投影保证）。正确投影时不会触发，仅约束 noUncheckedIndexedAccess。 */
function assertDefault(_tiers: TierMap): never {
  throw new Error("AgentProfile.llmTiers.default missing (投影契约违反：default 档必填)");
}
