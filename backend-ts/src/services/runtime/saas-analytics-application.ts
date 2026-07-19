import type { AsyncAnalyticsRepository } from "../../adapters/saas/postgres/analytics-repository.js";
import type { AnalyticsApplication } from "../../contracts/analytics-application.js";

/** Tenant-bound analytics facade used by HTTP routes. */
export class SaaSAnalyticsApplication implements AnalyticsApplication {
  constructor(
    private readonly tenantId: string,
    private readonly repository: AsyncAnalyticsRepository,
  ) {}

  aggregateTokenTrend(input: { since: string; bucket: "day" | "hour" }) {
    return this.repository.aggregateTokenTrend(this.tenantId, input);
  }

  aggregateModelUsage(input: { since: string }) {
    return this.repository.aggregateModelUsage(this.tenantId, input);
  }

  aggregateActivityHeatmap(input: { since: string }) {
    return this.repository.aggregateActivityHeatmap(this.tenantId, input);
  }

  aggregateDailyActivity(input: { since: string }) {
    return this.repository.aggregateDailyActivity(this.tenantId, input);
  }
}
