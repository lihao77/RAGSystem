import type { AgentMetricsStorePort } from "@ragsystem/backend-core/contracts/runtime/core-runtime-ports.js";
import type { ConversationStore } from "./sqlite/conversation-store/index.js";

/** Adapts Local's synchronous metric store to the shared Promise-only port. */
export class LocalAgentMetricsStoreAdapter implements AgentMetricsStorePort {
  constructor(private readonly store: Pick<ConversationStore, "insertMetric" | "aggregateMetrics" | "resetMetrics">) {}

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
