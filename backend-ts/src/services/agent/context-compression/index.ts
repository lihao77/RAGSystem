/**
 * 上下文预算 / 压缩设置的纯函数（供 AgentContextService.resolveContextBudget 与 monitoring 快照用）。
 *
 * 执行链的 LLM 摘要压缩由 SDK 运行时内核承担：自动路径走 round.before compaction-hook（compressIfNeeded），
 * 手动 /compact 走 SDK compactSession（forceCompact）。backend 不再实现压缩摘要，本文件只剩"算预算/读设置"。
 */
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { SystemConfigData } from "../../../contracts/system-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import { resolveTierLlmParams } from "../llm-params.js";

export interface ContextCompressionSettings {
  compressionTriggerRatio: number;
  summarizeMaxTokens: number;
  preserveRecentTurns: number;
  systemPromptReserve: number;
  minContextBudget: number;
}

const CONTEXT_WINDOW_SAFETY_FACTOR = 0.9;
const DEFAULT_CONTEXT_FALLBACK_MULTIPLIER = 3;
const DEFAULT_MAX_COMPLETION_TOKENS = 4096;

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
      positiveIntOrDefault(contextConfig.summarize_max_tokens, 300),
    ),
    preserveRecentTurns: positiveIntOrDefault(
      behaviorConfig.preserve_recent_turns,
      positiveIntOrDefault(contextConfig.preserve_recent_turns, 3),
    ),
    systemPromptReserve: nonNegativeIntOrDefault(contextConfig.system_prompt_reserve, 2000),
    minContextBudget: positiveIntOrDefault(contextConfig.min_context_budget, 4000),
  };
}

export function resolveContextBudget(
  agent: AgentConfig,
  provider: ModelProviderConfig | null,
  systemConfig: SystemConfigData,
  modelName: string | null,
): number {
  const settings = resolveContextCompressionSettings(agent, systemConfig);
  const systemLlmConfig = asRecord(systemConfig.llm) ?? {};
  const defaultLlm = agent.llm_tiers?.default;
  // 上下文窗口优先取 agent 默认层——与 resolveRequestLlmParams 同源：agent 为该模型调过的值优先于
  // provider 的通用默认；provider 次之，系统 LLM 配置兜底。
  const contextWindow =
    positiveInt(defaultLlm?.max_context_tokens) ??
    positiveInt(provider?.max_context_tokens) ??
    positiveInt(systemLlmConfig.max_context_tokens);
  // 补全预留按"本次实际运行模型"取：与请求壳同一套真相来源（resolveTierLlmParams），
  // 三级 fallback（场景 tier → default[selectedLlm 替换] → system）；provider/modelName 缺失
  // （如 usage 预览/快照）时回落默认层 → 系统 → 兜底常量。
  const runParams = provider && modelName
    ? resolveTierLlmParams({ agent, tier: "default", runModel: { provider, modelName }, systemLlm: systemLlmConfig })
    : null;
  const maxCompletionTokens =
    positiveInt(runParams?.maxCompletionTokens) ??
    positiveInt(defaultLlm?.max_completion_tokens) ??
    positiveInt(systemLlmConfig.max_completion_tokens) ??
    DEFAULT_MAX_COMPLETION_TOKENS;

  if (contextWindow !== null) {
    const budget = Math.floor(contextWindow * CONTEXT_WINDOW_SAFETY_FACTOR) - settings.systemPromptReserve - maxCompletionTokens;
    return Math.max(budget, settings.minContextBudget);
  }
  return Math.max(Math.floor(maxCompletionTokens * DEFAULT_CONTEXT_FALLBACK_MULTIPLIER), settings.minContextBudget);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
