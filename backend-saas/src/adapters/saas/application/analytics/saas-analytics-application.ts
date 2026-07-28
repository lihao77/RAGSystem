import type { AnalyticsApplication } from "@ragsystem/backend-core/contracts/application/analytics-application.js";
import type { AnalyticsRepositoryPort } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";

/** Tenant-bound analytics facade used by HTTP routes. */
export class SaaSAnalyticsApplication implements AnalyticsApplication {
  constructor(
    private readonly tenantId: string,
    private readonly repository: AnalyticsRepositoryPort,
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
