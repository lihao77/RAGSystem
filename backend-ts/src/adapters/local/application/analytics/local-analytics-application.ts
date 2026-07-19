import type { AnalyticsApplication } from "../../contracts/analytics-application.js";
import type { ConversationStore } from "./sqlite/conversation-store/index.js";

/** Local adapter: exposes synchronous SQLite analytics through the shared async port. */
export class LocalAnalyticsApplication implements AnalyticsApplication {
  constructor(private readonly store: Pick<ConversationStore, "aggregateTokenTrend" | "aggregateModelUsage" | "aggregateActivityHeatmap" | "aggregateDailyActivity">) {}
  async aggregateTokenTrend(input: { since: string; bucket: "day" | "hour" }) { return this.store.aggregateTokenTrend(input); }
  async aggregateModelUsage(input: { since: string }) { return this.store.aggregateModelUsage(input); }
  async aggregateActivityHeatmap(input: { since: string }) { return this.store.aggregateActivityHeatmap(input); }
  async aggregateDailyActivity(input: { since: string }) { return this.store.aggregateDailyActivity(input); }
}
