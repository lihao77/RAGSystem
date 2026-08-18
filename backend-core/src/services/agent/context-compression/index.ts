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
}

const CONTEXT_WINDOW_SAFETY_FACTOR = 0.9;

export function resolveContextCompressionSettings(agent: AgentConfig, systemConfig: SystemConfigData): ContextCompressionSettings {
  const contextConfig = asRecord(systemConfig.context) ?? {};
  const behaviorConfig = asRecord(agent.custom_params.behavior) ?? {};
  return {
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

function nonNegativeIntOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
