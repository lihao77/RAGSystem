import type { ModelProviderConfig } from "../../contracts/model-adapter.js";

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
