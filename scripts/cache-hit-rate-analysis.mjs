export function analyzeRoundCache(usage, rawUsage) {
  if (!usage) return { classification: "unreported", metricsReported: false, reason: "no_usage" };

  const inputTokens = nonNegativeNumber(usage.inputTokens) ?? 0;
  const cachedInputTokens = nonNegativeNumber(usage.cachedInputTokens);
  const cacheCreationInputTokens = nonNegativeNumber(usage.cacheCreationInputTokens);
  const deepSeekMissTokens = nonNegativeNumber(rawUsage?.prompt_cache_miss_tokens);
  const metricsReported = cachedInputTokens !== null || cacheCreationInputTokens !== null || deepSeekMissTokens !== null;
  if (!metricsReported) {
    return {
      classification: "unreported",
      metricsReported: false,
      inputTokens,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      uncachedInputTokens: null,
      hitRate: null,
      accountedRate: null,
    };
  }

  const cached = cachedInputTokens ?? 0;
  const created = cacheCreationInputTokens ?? 0;
  const uncached = deepSeekMissTokens ?? Math.max(0, inputTokens - cached - created);
  let classification = "miss";
  if (cached > 0 && created > 0) classification = "hit_and_write";
  else if (cached > 0) classification = "hit";
  else if (created > 0) classification = "cold_write";
  return {
    classification,
    metricsReported: true,
    inputTokens,
    cachedInputTokens: cached,
    cacheCreationInputTokens: created,
    uncachedInputTokens: uncached,
    hitRate: inputTokens > 0 ? cached / inputTokens : null,
    accountedRate: inputTokens > 0 ? Math.min(1, (cached + created) / inputTokens) : null,
  };
}

export function summarizeRounds(rounds) {
  const okRounds = rounds.filter((round) => round.status === "ok");
  const successful = okRounds.filter((round) => round.cache?.inputTokens > 0);
  const reported = successful.filter((round) => round.cache.metricsReported === true);
  const warm = reported.filter((round) => round.round > 1);
  const nonZero = reported.filter((round) => round.cache.cachedInputTokens > 0);
  const unreportedRounds = okRounds
    .filter((round) => round.cache?.metricsReported !== true)
    .map((round) => round.round);
  return {
    successfulRounds: successful.length,
    reportedRounds: reported.length,
    totalRounds: rounds.length,
    overallHitRate: aggregateRate(reported),
    reportedHitRate: aggregateRate(reported),
    warmHitRate: aggregateRate(warm),
    nonZeroConditionalHitRate: aggregateRate(nonZero),
    nonZeroHitRate: aggregateRate(nonZero),
    postToolHitRate: aggregateRate(reported.filter((round) => round.round >= 3)),
    totalInputTokens: sum(reported, (round) => round.cache.inputTokens),
    totalCachedInputTokens: sum(reported, (round) => round.cache.cachedInputTokens),
    totalCacheCreationInputTokens: sum(reported, (round) => round.cache.cacheCreationInputTokens),
    metricsReportedRounds: reported.length,
    unreportedRounds,
    zeroHitWarmRounds: warm.filter((round) => round.cache.cachedInputTokens === 0).map((round) => round.round),
    cacheDropRounds: warm.filter((round) => round.round >= 3 && round.cache.cachedInputTokens === 0).map((round) => round.round),
  };
}

export function analyzeTransitions(rounds) {
  const round1 = rounds.find((round) => round.round === 1 && round.status === "ok");
  const round2 = rounds.find((round) => round.round === 2 && round.status === "ok");
  const round3 = rounds.find((round) => round.round === 3 && round.status === "ok");
  if (!round1 || !round2 || !round3) return { conclusion: "insufficient_rounds" };
  if ([round1, round2, round3].some((round) => round.cache?.metricsReported !== true)) {
    return {
      conclusion: "cache_metrics_missing_for_transition",
      round1: round1.cache,
      round2: round2.cache,
      round3: round3.cache,
    };
  }
  const round2Hit = round2.cache.cachedInputTokens ?? 0;
  const round2Write = round2.cache.cacheCreationInputTokens ?? 0;
  const round3Hit = round3.cache.cachedInputTokens ?? 0;
  let conclusion = "cache_transition_unclear";
  if (round2Hit > 0 && round3Hit > round2Hit) conclusion = "round2_reused_old_prefix_and_round3_reused_tool_result_prefix";
  else if (round2Hit === 0 && round2Write > 0 && round3Hit > 0) conclusion = "round2_wrote_tool_result_and_round3_first_read_it";
  else if (round2Hit > 0 && round3Hit > 0) conclusion = "cache_hit_present_but_tool_result_growth_not_visible";
  else if (round3Hit === 0) conclusion = "tool_result_prefix_not_reused_by_round3";
  return {
    conclusion,
    round1: round1.cache,
    round2: round2.cache,
    round3: round3.cache,
  };
}

export function summarizeProviderResults(providers) {
  const successful = providers.filter((provider) => provider.summary.successfulRounds > 0);
  const rounds = successful.flatMap((provider) => provider.rounds)
    .filter((round) => round.status === "ok" && round.cache?.inputTokens > 0 && round.cache.metricsReported === true);
  const unreportedRounds = providers.flatMap((provider) => (provider.summary.unreportedRounds ?? []).map((round) => ({
    providerKey: provider.providerKey,
    round,
  })));
  const conditionalRounds = rounds.filter((round) => round.cache.cachedInputTokens > 0);
  return {
    providerCount: providers.length,
    providersWithUsage: successful.length,
    providersWithReportedCacheMetrics: providers.filter((provider) => provider.summary.reportedRounds > 0).length,
    overallHitRate: aggregateRate(rounds),
    reportedHitRate: aggregateRate(rounds),
    warmHitRate: aggregateRate(rounds.filter((round) => round.round > 1)),
    nonZeroConditionalHitRate: aggregateRate(conditionalRounds),
    nonZeroHitRate: aggregateRate(conditionalRounds),
    unreportedRounds,
  };
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function aggregateRate(rounds) {
  const input = sum(rounds, (round) => round.cache.inputTokens);
  const cached = sum(rounds, (round) => round.cache.cachedInputTokens);
  return input > 0 ? cached / input : null;
}

function sum(items, selector) {
  return items.reduce((total, item) => total + (selector(item) ?? 0), 0);
}
