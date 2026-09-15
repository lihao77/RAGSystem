import type { ModelProviderConfig } from "../../contracts/integrations/model-adapter.js";

/**
 * provider 引用三元组：tier 配置 / 系统配置里描述一个 LLM 目标的最小形态。
 * 与 RuntimeCoreService 内部的 ResolvedLlm 结构兼容（不含 source 等运行时字段）。
 */
export interface ProviderRef {
  provider: string | null;
  provider_type: string | null;
  model_name: string | null;
}

/**
 * 归一化键：trim + 小写。用于 provider 名/key、provider_type、model_name 的
 * 匹配与去重（摘要 tier fallback 的去重键也复用本函数）。永不返回 falsy。
 */
export function normalizeProviderKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * 在已加载 providers 中按 (provider 名/key, provider_type) 查找完整 ModelProviderConfig。
 * 匹配规则：provider_type 非空则先精确过滤，再在 provider.key / provider.name 上归一化匹配。
 * 抽取自原 RuntimeCoreService 的私有 findProvider，行为逐字一致；摘要 tier resolver 与
 * runtime 解析共用同一份（禁双写）。
 */
export function findProviderByRef(
  providers: ModelProviderConfig[],
  ref: Pick<ProviderRef, "provider" | "provider_type">,
): ModelProviderConfig | null {
  if (!ref.provider) {
    return null;
  }
  const providerRef = normalizeProviderKey(ref.provider);
  const providerType = normalizeProviderKey(ref.provider_type);
  return (
    providers.find((provider) => {
      if (providerType && normalizeProviderKey(provider.provider_type) !== providerType) {
        return false;
      }
      return [provider.key, provider.name].some((value) => normalizeProviderKey(value) === providerRef);
    }) ?? null
  );
}

/**
 * 模型是否在 provider 的模型列表中（trim + 小写归一匹配）。readiness 的
 * model_available 与 tier 引用可解析判定共用，保证两层口径一致——归一匹配是
 * 就绪判定的口径，勿与投影层 findModelEntry 的精确匹配（参数/能力位）混用。
 */
export function isProviderModelAvailable(provider: ModelProviderConfig, modelName: string | null): boolean {
  if (!modelName) {
    return false;
  }
  const target = normalizeProviderKey(modelName);
  return provider.models.some((model) => normalizeProviderKey(model.name) === target);
}

/**
 * tier / 系统 LLM 配置的同构引用（AgentLlmConfig / SystemLlmConfig 形态，
 * 字段可空可缺），供引用可解析判定。
 */
export type ResolvableProviderRef = {
  provider?: string | null | undefined;
  provider_type?: string | null | undefined;
  model_name?: string | null | undefined;
};

/**
 * tier / 系统 LLM 引用是否可解析：provider 能按 (name/key, provider_type) 找到，
 * 且 model_name 在该 provider 的模型列表中。引用失效（悬空 provider、模型下架、
 * 半空残壳）统一判 false，是「失效回落系统 LLM」策略的唯一判定点。
 */
export function providerRefResolves(
  providers: ModelProviderConfig[],
  ref: ResolvableProviderRef,
): boolean {
  const provider = findProviderByRef(providers, {
    provider: ref.provider ?? null,
    provider_type: ref.provider_type ?? null,
  });
  return provider !== null && isProviderModelAvailable(provider, ref.model_name ?? null);
}
