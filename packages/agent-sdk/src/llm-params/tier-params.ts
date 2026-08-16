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
import type { TierMap } from "../types.js";

/**
 * 读 tiers[tier] 的生成参数；tier 缺档时回落 default。
 *
 * 标量字段（temperature / maxCompletionTokens / thinkingLevel）：场景 tier → default 逐级 ??（两级）。
 * extraParams：场景 tier → default 合并（后者覆盖前者同名 key），空值过滤。
 */
export function readTierParams(tiers: TierMap, tier: string): RequestLlmParams {
  const tierEntry = tiers[tier];
  // default 档可缺：preview 不调 LLM、不需 tier（run 用 profile 由 createRuntime.run 守卫 default 必填）。
  const defaultEntry = tiers.default;
  return {
    temperature: tierEntry?.temperature ?? defaultEntry?.temperature ?? null,
    maxCompletionTokens: tierEntry?.maxCompletionTokens ?? defaultEntry?.maxCompletionTokens ?? null,
    extraParams: compactRecord(defaultEntry?.extraParams, tierEntry?.extraParams),
    thinkingLevel: tierEntry?.thinkingLevel ?? defaultEntry?.thinkingLevel ?? null,
  };
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
