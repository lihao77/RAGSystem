import { describe, expect, it, vi } from "vitest";
import { LocalAnalyticsApplication } from "../../../src/services/runtime/local-analytics-application.js";

describe("LocalAnalyticsApplication", () => {
  it("adapts synchronous ConversationStore aggregation to async contract", async () => {
    const store = {
      aggregateTokenTrend: vi.fn(() => [{ ts: "2026-07-19", token_in: 1, token_out: 2, calls: 1 }]),
      aggregateModelUsage: vi.fn(() => []),
      aggregateActivityHeatmap: vi.fn(() => []),
      aggregateDailyActivity: vi.fn(() => []),
    };
    const application = new LocalAnalyticsApplication(store as never);
    await expect(application.aggregateTokenTrend({ since: "2026-07-01", bucket: "day" })).resolves.toEqual(store.aggregateTokenTrend());
    expect(store.aggregateTokenTrend).toHaveBeenCalledWith({ since: "2026-07-01", bucket: "day" });
  });
});
