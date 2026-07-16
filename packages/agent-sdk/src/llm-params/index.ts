/** tier 表读取公共导出（设计稿 §3/§9）。 */
export { readTierParams, compactRecord } from "./tier-params.js";
export { resolveContextBudget } from "./budget.js";
export { resolveSummaryTierCandidates } from "./summary-tier.js";
export type { SummaryTierCandidate } from "./summary-tier.js";
export { buildPromptCacheKey } from "./prompt-cache-key.js";
