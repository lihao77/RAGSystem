import type { DailyActivityPoint, HeatmapPoint, ModelUsagePoint, TokenTrendPoint } from "../conversation-store/index.js";

/**
 * 管理中心分析聚合。日/小时/星期分桶按 timeZone（IANA 名）的墙钟时间切，
 * 缺省由路由层解析为服务器本地时区；模型用量不含时间桶，无需时区。
 */
export interface AnalyticsApplication {
  aggregateTokenTrend(input: { since: string; bucket: "day" | "hour"; timeZone?: string }): Promise<TokenTrendPoint[]>;
  aggregateModelUsage(input: { since: string }): Promise<ModelUsagePoint[]>;
  aggregateActivityHeatmap(input: { since: string; timeZone?: string }): Promise<HeatmapPoint[]>;
  aggregateDailyActivity(input: { since: string; timeZone?: string }): Promise<DailyActivityPoint[]>;
}
