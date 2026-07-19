import { describe, expect, it, vi } from "vitest";

import { SaaSAnalyticsApplication } from "../../../src/adapters/saas/application/analytics/saas-analytics-application.js";

describe("SaaSAnalyticsApplication", () => {
  it("binds all analytics reads to its tenant", async () => {
    const repository = {
      aggregateTokenTrend: vi.fn(async () => []),
      aggregateModelUsage: vi.fn(async () => []),
      aggregateActivityHeatmap: vi.fn(async () => []),
      aggregateDailyActivity: vi.fn(async () => []),
    };
    const application = new SaaSAnalyticsApplication("tenant-a", repository as never);
    const since = "2026-07-01T00:00:00.000Z";

    await application.aggregateTokenTrend({ since, bucket: "hour" });
    await application.aggregateModelUsage({ since });
    await application.aggregateActivityHeatmap({ since });
    await application.aggregateDailyActivity({ since });

    expect(repository.aggregateTokenTrend).toHaveBeenCalledWith("tenant-a", { since, bucket: "hour" });
    expect(repository.aggregateModelUsage).toHaveBeenCalledWith("tenant-a", { since });
    expect(repository.aggregateActivityHeatmap).toHaveBeenCalledWith("tenant-a", { since });
    expect(repository.aggregateDailyActivity).toHaveBeenCalledWith("tenant-a", { since });
  });
});
