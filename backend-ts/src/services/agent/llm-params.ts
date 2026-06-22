import type { AgentConfig, AgentLlmConfig } from "../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../contracts/model-adapter.js";
import { normalizeProviderKey } from "../runtime/provider-lookup.js";

export interface RequestLlmParams {
  temperature: number | null;
  maxCompletionTokens: number | null;
  extraParams: Record<string, unknown>;
}

/**
 * 解析"本次实际运行模型"的请求参数（temperature / max_completion_tokens）——
 * 用谁就用谁那套默认参数：
 * - 运行模型 == agent 默认层(`llm_tiers.default`) → 用默认层参数（agent 为该模型调过的值）。
 * - 否则（selectedLlm 选中的其它模型，与默认层不同）→ 用该模型 provider 自带的默认参数。
 *
 * 运行选模只有「默认层」与「selectedLlm 覆盖」两种来源（见 RuntimeCoreService.resolveLlm），
 * 故"是否等于默认层模型"即可区分；不必把来源一路透传到协议层。
 * 协议层组请求壳、上下文预算预留补全 token 都复用本函数，单一真相来源。
 */
export function resolveRequestLlmParams(
  agent: AgentConfig,
  provider: ModelProviderConfig,
  modelName: string,
): RequestLlmParams {
  const defaultTier = agent.llm_tiers?.default;
  if (defaultTier && isDefaultTierModel(defaultTier, provider, modelName)) {
    return {
      temperature: numberOrNull(defaultTier.temperature),
      maxCompletionTokens: numberOrNull(defaultTier.max_completion_tokens),
      extraParams: compactRecord(provider.extra_params, defaultTier.extra_params),
    };
  }
  return {
    temperature: numberOrNull(provider.temperature),
    maxCompletionTokens: numberOrNull(provider.max_completion_tokens) ?? numberOrNull(provider.max_tokens),
    extraParams: compactRecord(provider.extra_params),
  };
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
