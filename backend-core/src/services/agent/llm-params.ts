import type { AgentConfig, AgentLlmConfig } from "../../contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../../contracts/integrations/model-adapter.js";
import { normalizeProviderKey } from "../runtime/provider-lookup.js";

export interface RequestLlmParams {
  temperature: number | null;
  maxCompletionTokens: number | null;
  extraParams: Record<string, unknown>;
}

/**
 * LLM 参数源：tier / default / system 三层各自的参数载体，同构形态。
 * agent tier 配置、provider 自带参数、systemConfig.llm 都按此形态读取。
 */
type LlmParamSource = {
  temperature?: unknown;
  max_completion_tokens?: unknown;
  max_tokens?: unknown;
  extra_params?: unknown;
};

/**
 * 解析本次 LLM 调用的生成参数（temperature / max_completion_tokens / extra_params），
 * 统一三级 fallback：
 *   [场景 tier] → [default（= selectedLlm 或 agent.default）] → [systemConfig.llm]
 *
 * - default 位置：runModel 是 agent 默认层模型时取 `agent.llm_tiers.default`；
 *   否则（前端 selectedLlm 替换了 default）取 runModel.provider 自带参数——
 *   selectedLlm 连模型带参数一起替换 default 位置，不影响其它 tier（如摘要的 fast）。
 * - 场景 tier：主运行/子 agent 传 "default"（直接用 default 位置）；摘要传 "fast"
 *   等具体 tier，取 `agent.llm_tiers[tier]` 配置。
 * - 标量字段（temperature / max_completion_tokens）逐级 ?? 回落；
 *   extra_params 三层 merge（后者覆盖前者同名 key），空值过滤。
 *
 * 协议层组请求壳、上下文预算预留补全 token、摘要请求都复用本函数，单一真相来源。
 */
export function resolveTierLlmParams(input: {
  agent: AgentConfig;
  tier: string;
  runModel: { provider: ModelProviderConfig; modelName: string };
  systemLlm: Record<string, unknown> | null;
}): RequestLlmParams {
  const defaultSource = resolveDefaultSource(input.agent, input.runModel);
  const tierSource = input.tier === "default" ? null : asParamSource(input.agent.llm_tiers?.[input.tier]);
  const systemSource = asParamSource(input.systemLlm);

  return {
    temperature: firstNumber([
      tierSource?.temperature,
      defaultSource.temperature,
      systemSource?.temperature,
    ]),
    maxCompletionTokens: firstNumber([
      tierSource?.max_completion_tokens ?? tierSource?.max_tokens,
      defaultSource.max_completion_tokens ?? defaultSource.max_tokens,
      systemSource?.max_completion_tokens ?? systemSource?.max_tokens,
    ]),
    extraParams: compactRecord(systemSource?.extra_params, defaultSource.extra_params, tierSource?.extra_params),
  };
}

/** default 位置参数源：runModel 是 agent 默认层模型 → agent.llm_tiers.default；否则（selectedLlm）→ provider。 */
function resolveDefaultSource(
  agent: AgentConfig,
  runModel: { provider: ModelProviderConfig; modelName: string },
): LlmParamSource {
  const defaultTier = agent.llm_tiers?.default;
  if (defaultTier && isDefaultTierModel(defaultTier, runModel.provider, runModel.modelName)) {
    return asParamSource(defaultTier) ?? {};
  }
  return providerAsParamSource(runModel.provider);
}

/** provider → 同构参数源（selectedLlm 替换 default 时，参数取自该 provider）。 */
function providerAsParamSource(provider: ModelProviderConfig): LlmParamSource {
  return {
    temperature: provider.temperature,
    max_completion_tokens: provider.max_completion_tokens,
    max_tokens: provider.max_tokens,
    extra_params: (provider as Record<string, unknown>).extra_params,
  };
}

function asParamSource(value: unknown): LlmParamSource | null {
  return isRecordLike(value) ? (value as LlmParamSource) : null;
}

/** 取首个有效数值（null/undefined/非有限数跳过）；全无效返回 null。 */
function firstNumber(values: Array<unknown>): number | null {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) {
      return n;
    }
  }
  return null;
}

/** 运行的 (provider, modelName) 是否就是 agent 默认层指向的模型。 */
function isDefaultTierModel(
  defaultTier: AgentLlmConfig,
  provider: ModelProviderConfig,
  modelName: string,
): boolean {
  if (normalizeProviderKey(defaultTier.model_name) !== normalizeProviderKey(modelName)) {
    return false;
  }
  const tierProviderRef = normalizeProviderKey(defaultTier.provider);
  if (!tierProviderRef) {
    return false;
  }
  return [provider.key, provider.name].some((value) => normalizeProviderKey(value) === tierProviderRef);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 合并若干 extra_params 来源（后者覆盖前者同名 key），过滤 null/undefined 条目。
 * 单参即 compact——extra_params 作为请求扩展点，空值不发；provider/agent 的 extra_params
 * 均经此归一后再进请求 body。协议层显式字段（model/messages/temperature/max_tokens 等）
 * 在 body 构造时后置 spread，永远不被 extra 覆盖。
 */
export function compactRecord(...sources: Array<unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!isRecordLike(source)) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (value !== null && value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}
