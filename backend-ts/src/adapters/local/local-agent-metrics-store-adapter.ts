import type { IMetricStore } from "../../contracts/conversation-store/index.js";
import type { AgentMetricsStorePort } from "../../contracts/runtime/core-runtime-ports.js";

/** Adapts Local's synchronous metric store to the shared Promise-only port. */
export class LocalAgentMetricsStoreAdapter implements AgentMetricsStorePort {
  constructor(private readonly store: IMetricStore) {}

  async insertMetric(input: Parameters<AgentMetricsStorePort["insertMetric"]>[0]): Promise<void> {
    this.store.insertMetric(input);
  }

  async aggregateMetrics(agentName?: string | null) {
    return this.store.aggregateMetrics(agentName);
  }

  async resetMetrics(agentName?: string | null) {
    return this.store.resetMetrics(agentName);
  }
}
