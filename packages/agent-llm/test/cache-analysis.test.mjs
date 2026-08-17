import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeRoundCache,
  analyzeTransitions,
  summarizeProviderResults,
  summarizeRounds,
} from "../../../scripts/cache-hit-rate-analysis.mjs";

test("cache analysis keeps unreported metrics out of hit-rate denominators", () => {
  const unreported = analyzeRoundCache({ inputTokens: 100, outputTokens: 5, totalTokens: 105 }, null);
  assert.equal(unreported.classification, "unreported");
  assert.equal(unreported.metricsReported, false);
  assert.equal(unreported.hitRate, null);

  const rounds = [
    { round: 1, status: "ok", cache: analyzeRoundCache({ inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 0 }, null) },
    { round: 2, status: "ok", cache: unreported },
    { round: 3, status: "ok", cache: analyzeRoundCache({ inputTokens: 120, outputTokens: 5, totalTokens: 125, cachedInputTokens: 90 }, null) },
  ];
  const summary = summarizeRounds(rounds);

  assert.equal(summary.reportedRounds, 2);
  assert.equal(summary.reportedHitRate, 90 / 220);
  assert.equal(summary.warmHitRate, 90 / 120);
  assert.deepEqual(summary.unreportedRounds, [2]);
  assert.deepEqual(summary.zeroHitWarmRounds, []);
  assert.deepEqual(summary.cacheDropRounds, []);
});

test("cache transition analysis reports missing metrics instead of a false miss", () => {
  const rounds = [1, 2, 3].map((round) => ({
    round,
    status: "ok",
    cache: analyzeRoundCache({ inputTokens: 100, outputTokens: 5, totalTokens: 105 }, null),
  }));
  assert.equal(analyzeTransitions(rounds).conclusion, "cache_metrics_missing_for_transition");
});

test("provider aggregation excludes unreported rounds", () => {
  const reported = analyzeRoundCache({ inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 80 }, null);
  const unreported = analyzeRoundCache({ inputTokens: 100, outputTokens: 5, totalTokens: 105 }, null);
  const providers = [{
    providerKey: "test",
    rounds: [
      { round: 1, status: "ok", cache: reported },
      { round: 2, status: "ok", cache: unreported },
    ],
    summary: summarizeRounds([
      { round: 1, status: "ok", cache: reported },
      { round: 2, status: "ok", cache: unreported },
    ]),
  }];
  const summary = summarizeProviderResults(providers);
  assert.equal(summary.reportedHitRate, 0.8);
  assert.deepEqual(summary.unreportedRounds, [{ providerKey: "test", round: 2 }]);
});
