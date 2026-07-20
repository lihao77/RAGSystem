import type { AgentMetricSummary } from "../../../contracts/conversation-store/index.js";
import type { AgentMetricsStorePort } from "../../../contracts/runtime/core-runtime-ports.js";
import type { AsyncAgentMetricsRepository, AnalyticsMetricInput } from "../../../contracts/storage/async-persistence-ports.js";
import type { TenantId } from "../../../identity/types.js";

/** Tenant-bound adapter exposing PostgreSQL analytics to the runtime collector. */
export class SaaSAgentMetricsStore implements AgentMetricsStorePort {
  constructor(
    private readonly tenantId: TenantId,
    private readonly analytics: AsyncAgentMetricsRepository,
  ) {}

  insertMetric(input: AnalyticsMetricInput): Promise<void> {
    return this.analytics.insertMetric(this.tenantId, input);
  }

  aggregateMetrics(agentName?: string | null): Promise<AgentMetricSummary[]> {
    return this.analytics.aggregateMetrics(this.tenantId, agentName);
  }

  resetMetrics(agentName?: string | null): Promise<{ deleted: number }> {
    return this.analytics.resetMetrics(this.tenantId, agentName);
  }
}
