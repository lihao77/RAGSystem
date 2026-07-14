import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { requireTenantAdmin } from "../tenant-role.js";

/**
 * 管理中心数据分析端点。基于 agent_call_metrics 明细做时间序列 / 分组聚合,
 * 供前端 AdminCenter 的 token 趋势、模型用量、活跃热力图三张图消费。
 * 风格对齐 monitoring.ts:ok 包装、HttpError 抛错、query 手动解析。
 */
interface RangeQuery {
  days?: string;
}

interface TokenTrendQuery extends RangeQuery {
  bucket?: string;
}

const DEFAULT_TOKEN_DAYS = 7;
const DEFAULT_MODEL_DAYS = 7;
const DEFAULT_HEATMAP_DAYS = 90;
const DEFAULT_DAILY_DAYS = 180;
const MAX_DAYS = 365;

function parseDays(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 1 || num > MAX_DAYS) {
    throw new HttpError(400, "invalid_request", `days 必须是 1-${MAX_DAYS} 之间的整数`);
  }
  return num;
}

function daysToSince(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export const registerAnalyticsRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => { requireTenantAdmin(request); });

  app.get("/analytics/token-trend", async (request) => {
    const query = request.query as TokenTrendQuery;
    const days = parseDays(query.days, DEFAULT_TOKEN_DAYS);
    const bucket = query.bucket ?? "day";
    if (bucket !== "day" && bucket !== "hour") {
      throw new HttpError(400, "invalid_request", "bucket 必须是 day 或 hour");
    }
    const rows = request.container.conversationStore.aggregateTokenTrend({
      since: daysToSince(days),
      bucket,
    });
    return ok(rows, "获取 token 趋势成功");
  });

  app.get("/analytics/model-usage", async (request) => {
    const query = request.query as RangeQuery;
    const days = parseDays(query.days, DEFAULT_MODEL_DAYS);
    const rows = request.container.conversationStore.aggregateModelUsage({ since: daysToSince(days) });
    return ok(rows, "获取模型用量成功");
  });

  app.get("/analytics/activity-heatmap", async (request) => {
    const query = request.query as RangeQuery;
    const days = parseDays(query.days, DEFAULT_HEATMAP_DAYS);
    const rows = request.container.conversationStore.aggregateActivityHeatmap({ since: daysToSince(days) });
    return ok(rows, "获取活跃热力图成功");
  });

  app.get("/analytics/daily-activity", async (request) => {
    const query = request.query as RangeQuery;
    const days = parseDays(query.days, DEFAULT_DAILY_DAYS);
    const rows = request.container.conversationStore.aggregateDailyActivity({ since: daysToSince(days) });
    return ok(rows, "获取每日活跃度成功");
  });
};
