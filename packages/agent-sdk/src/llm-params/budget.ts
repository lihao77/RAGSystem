/**
 * 上下文预算 —— 纯算术。
 *
 * budget = window × 0.9 − systemPromptTokens,clamp 到内置兜底。
 * - window×0.9:留 10% 给模型回复 + 安全余量。
 * - − systemPromptTokens:扣实际 system prompt token(含 memory prefix,非历史的固定消耗)。
 * - 剩下给对话历史(含附件 token)。
 * - 窗口缺失或预算为负时用固定兜底,不再向调用方暴露最小预算配置。
 */
import type { TierMap } from "../types.js";

const FALLBACK_CONTEXT_BUDGET_TOKENS = 4000;

export function resolveContextBudget(
  tiers: TierMap,
  systemPromptTokens: number,
): number {
  const defaultTier = tiers.default;
  // default 缺(preview/monitoring 容忍 optional)或窗口未配 → 内置兜底,不 throw。
  if (!defaultTier || defaultTier.maxContextTokens === null) {
    return FALLBACK_CONTEXT_BUDGET_TOKENS;
  }
  const budget = Math.floor(defaultTier.maxContextTokens * 0.9) - systemPromptTokens;
  return Math.max(budget, FALLBACK_CONTEXT_BUDGET_TOKENS);
}
