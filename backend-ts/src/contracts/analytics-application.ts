import type { DailyActivityPoint, HeatmapPoint, ModelUsagePoint, TokenTrendPoint } from "./conversation-store/index.js";

export interface AnalyticsApplication {
  aggregateTokenTrend(input: { since: string; bucket: "day" | "hour" }): Promise<TokenTrendPoint[]>;
  aggregateModelUsage(input: { since: string }): Promise<ModelUsagePoint[]>;
  aggregateActivityHeatmap(input: { since: string }): Promise<HeatmapPoint[]>;
  aggregateDailyActivity(input: { since: string }): Promise<DailyActivityPoint[]>;
}
