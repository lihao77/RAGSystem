/**
 * tier 表读取 —— LLM 参数（设计稿 §3）。
 *
 * 投影已算死（tier 引用→provider 内联、selectLlm 替换 default、字段回落算完），
 * 内核零兜底：两级 fallback（场景 tier → default），不含任何多源回落。
 *
 * 与 backend-ts resolveTierLlmParams 的差异：删 systemLlm 第三级、删 resolveDefaultSource
 * 特殊分支（selectLlm 替换 default 已在投影层做完）。
 */
import type { RequestLlmParams } from "@ragsystem/agent-llm";
import type { ResolvedTier, TierMap } from "../types.js";

/**
 * 读 tiers[tier] 的生成参数；tier 缺档时回落 default。
 *
 * 标量字段（temperature / maxCompletionTokens）：场景 tier → default 逐级 ??（两级）。
 * extraParams：场景 tier → default 合并（后者覆盖前者同名 key），空值过滤。
 */
export function readTierParams(tiers: TierMap, tier: string): RequestLlmParams {
  const tierEntry = tiers[tier];
  // 契约：tiers.default 恒在（投影保证，§3 契约约束）。
  const defaultEntry = tiers.default ?? assertDefault(tiers);
  return {
    temperature: tierEntry?.temperature ?? defaultEntry.temperature,
    maxCompletionTokens: tierEntry?.maxCompletionTokens ?? defaultEntry.maxCompletionTokens,
    extraParams: compactRecord(defaultEntry.extraParams, tierEntry?.extraParams),
  };
}

/** 契约守卫：default 档必填（投影保证）。正确投影时不会触发，仅约束 noUncheckedIndexedAccess。 */
function assertDefault(_tiers: TierMap): ResolvedTier {
  throw new Error("AgentProfile.llmTiers.default missing (投影契约违反：default 档必填)");
}

/** 合并 extraParams 来源（后者覆盖前者同名 key），过滤 null/undefined。 */
export function compactRecord(
  ...sources: ReadonlyArray<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source) {
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
