/**
 * 上下文预算 —— 纯算术。
 *
 * budget = window × 0.9 − systemPromptTokens,clamp 到 minContextBudget。
 * - window×0.9:留 10% 给模型回复 + 安全余量。
 * - − systemPromptTokens:扣实际 system prompt token(含 memory prefix,非历史的固定消耗)。
 * - 剩下给对话历史(含附件 token)。
 */
import type { CompressionBudgetConfig, TierMap } from "../types.js";
import { DEFAULT_COMPRESSION_BUDGET } from "../types.js";

export function resolveContextBudget(
  tiers: TierMap,
  systemPromptTokens: number,
  config: CompressionBudgetConfig = DEFAULT_COMPRESSION_BUDGET,
): number {
  const defaultTier = tiers.default;
  // default 缺(preview/monitoring 容忍 optional)或窗口未配 → minContextBudget 兜底,不 throw。
  if (!defaultTier || defaultTier.maxContextTokens === null) {
    return config.minContextBudget;
  }
  const budget = Math.floor(defaultTier.maxContextTokens * 0.9) - systemPromptTokens;
  return Math.max(budget, config.minContextBudget);
}
