/**
 * 压缩摘要模型候选 —— 读 tier 表去重（设计稿 §3）。
 *
 * 投影算死后只剩 [tiers.fast, tiers.default] 两档；去重（(provider key, provider_type,
 * modelName) 三元组归一）。fast 缺档（投影未补）则只剩 default。不含 provider 解析与 system 兜底。
 */
import type { TierMap } from "../types.js";
import type { ResolvedTier } from "../types.js";

export interface SummaryTierCandidate {
  tier: string;
  provider: ResolvedTier["provider"];
  modelName: string;
}

export function resolveSummaryTierCandidates(tiers: TierMap): SummaryTierCandidate[] {
  const seen = new Set<string>();
  const candidates: SummaryTierCandidate[] = [];
  const tryPush = (tier: string, entry: ResolvedTier | undefined): void => {
    if (!entry) {
      return;
    }
    const key = `${normalizeKey(entry.provider.key)}|${normalizeKey(entry.provider.provider_type)}|${normalizeKey(entry.modelName)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ tier, provider: entry.provider, modelName: entry.modelName });
  };
  tryPush("fast", tiers.fast);
  tryPush("default", tiers.default);
  return candidates;
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
