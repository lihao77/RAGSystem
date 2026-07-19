import type { AnalyticsApplication } from "../../contracts/analytics-application.js";
import type { ConversationStore } from "../stores/conversation-store/index.js";

/** Async facade over Local's synchronous analytics aggregation. */
export class LocalAnalyticsApplication implements AnalyticsApplication {
  constructor(private readonly store: Pick<ConversationStore, "aggregateTokenTrend" | "aggregateModelUsage" | "aggregateActivityHeatmap" | "aggregateDailyActivity">) {}
  async aggregateTokenTrend(input: { since: string; bucket: "day" | "hour" }) { return this.store.aggregateTokenTrend(input); }
  async aggregateModelUsage(input: { since: string }) { return this.store.aggregateModelUsage(input); }
  async aggregateActivityHeatmap(input: { since: string }) { return this.store.aggregateActivityHeatmap(input); }
  async aggregateDailyActivity(input: { since: string }) { return this.store.aggregateDailyActivity(input); }
}
