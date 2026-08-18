import { asRecord } from "../../../utils/guards.js";
/**
 * 上下文预算 / 压缩设置的纯函数（供 AgentContextService.resolveContextBudget 与 monitoring 快照用）。
 *
 * 执行链的 LLM 摘要压缩由 SDK 运行时内核承担：自动路径走 round.before compaction-hook（compressIfNeeded），
 * 手动 /compact 走 SDK compactSession（forceCompact）。backend 不再实现压缩摘要，本文件只剩"算预算/读设置"。
 */
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { SystemConfigData } from "../../../contracts/runtime/system-config.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import { resolveTierLlmParams } from "../llm-params.js";

export interface ContextCompressionSettings {
  compressionTriggerRatio: number;
  summarizeMaxTokens: number;
  preserveRecentTurns: number;
  /** 保留区 token 下限:除条数下限外,保留区估算 token 不低于此值,避免"保留 6 条但只有几百 token"叙事断裂。 */
  preserveMinTokens: number;
  /** 保留区 token 上限:单条超限也只能整条保留;user 锚点内收同样受此上限约束。 */
  preserveMaxTokens: number;
  /** 真实加载预算;存在时保留区 token 上限优先于条数下限。 */
  preserveBudgetTokens?: number;
}

const CONTEXT_WINDOW_SAFETY_FACTOR = 0.9;

/** 保留区 token 预算相对历史总预算的上限占比——小窗/未知窗(兜底 4000)也能压得出效果。 */
const PRESERVE_BUDGET_RATIO = 0.25;

/**
 * 保留区 token 预算钳制到实际历史预算:小窗模型(如兜底 4000)下默认值 8000/40000 会让保留区
 * 比整段历史预算还大,选段只能返回 missing_segment_seq → 压缩永久失效、超限请求持续打向 provider。
 * 钳到 budget×25%(保留区过阈值即触发二次压缩,天然收敛),同时归一化 min/max 关系。
 */
export function normalizePreserveTokenBudgets(
  minTokens: number,
  maxTokens: number,
  budgetTokens: number,
): { preserveMinTokens: number; preserveMaxTokens: number } {
  const cap = Math.max(1, Math.floor(Math.max(1, finitePositiveIntOrOne(budgetTokens)) * PRESERVE_BUDGET_RATIO));
  const range = normalizePreserveTokenRange(minTokens, maxTokens);
  const preserveMaxTokens = Math.min(range.preserveMaxTokens, cap);
  return {
    preserveMinTokens: Math.min(range.preserveMinTokens, preserveMaxTokens),
    preserveMaxTokens,
  };
}

export function resolveContextCompressionSettings(agent: AgentConfig, systemConfig: SystemConfigData): ContextCompressionSettings {
  const contextConfig = asRecord(systemConfig.context) ?? {};
  const behaviorConfig = asRecord(agent.custom_params.behavior) ?? {};
  const settings = {
    compressionTriggerRatio: clamp(
      numberOrDefault(behaviorConfig.compression_trigger_ratio, numberOrDefault(contextConfig.compression_trigger_ratio, 0.85)),
      0.5,
      0.99,
    ),
    summarizeMaxTokens: positiveIntOrDefault(
      behaviorConfig.summarize_max_tokens,
      positiveIntOrDefault(contextConfig.summarize_max_tokens, 30000),
    ),
    preserveRecentTurns: positiveIntOrDefault(
      behaviorConfig.preserve_recent_turns,
      positiveIntOrDefault(contextConfig.preserve_recent_turns, 3),
    ),
    preserveMinTokens: positiveIntOrDefault(
      behaviorConfig.preserve_min_tokens,
      positiveIntOrDefault(contextConfig.preserve_min_tokens, 8000),
    ),
    preserveMaxTokens: positiveIntOrDefault(
      behaviorConfig.preserve_max_tokens,
      positiveIntOrDefault(contextConfig.preserve_max_tokens, 40000),
    ),
  };
  return { ...settings, ...normalizePreserveTokenRange(settings.preserveMinTokens, settings.preserveMaxTokens) };
}

function normalizePreserveTokenRange(minTokens: number, maxTokens: number): Pick<ContextCompressionSettings, "preserveMinTokens" | "preserveMaxTokens"> {
  const preserveMinTokens = finitePositiveIntOrOne(minTokens);
  const preserveMaxTokens = finitePositiveIntOrOne(maxTokens);
  return {
    preserveMinTokens: Math.min(preserveMinTokens, preserveMaxTokens),
    preserveMaxTokens,
  };
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function positiveIntOrDefault(value: unknown, fallback: number): number {
  return positiveInt(value) ?? fallback;
}

function finitePositiveIntOrOne(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1;
}

function nonNegativeIntOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
