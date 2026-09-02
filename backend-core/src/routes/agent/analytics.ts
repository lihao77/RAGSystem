import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { requireTenantAdmin } from "../tenant-role.js";
import { ensureRequestApplications } from "../../app/request-applications.js";

/**
 * 管理中心数据分析端点。基于 agent_call_metrics 明细做时间序列 / 分组聚合,
 * 供前端 AdminCenter 的 token 趋势、模型用量、活跃热力图三张图消费。
 * 风格对齐 monitoring.ts:ok 包装、HttpError 抛错、query 手动解析。
 */
interface RangeQuery {
  days?: string;
  tz?: string;
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

/**
 * 分桶时区：前端传浏览器 IANA 时区名，各查看者各自的"天"各自正确；
 * 未传时缺省服务器本地时区（本地部署即用户时区）。SQLite/Postgres 均按该时区墙钟切桶。
 */
function parseTimeZone(value: string | undefined): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (value === undefined || value === "") {
    return fallback;
  }
  try {
    // resolvedOptions 顺带把别名归一为规范 IANA 名；Intl 会接受 "+08:00" 这类偏移形式，
    // 但 Postgres 按 POSIX 语义对偏移取反，两后端会分叉——只放行 IANA 名。
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    if (!resolved || /^[+-]/.test(resolved)) {
      throw new RangeError(`offset-style timezone is not accepted: ${value}`);
    }
    return resolved;
  } catch {
    throw new HttpError(400, "invalid_request", `tz 不是合法的 IANA 时区名: ${value}`);
  }
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
    const input: { since: string; bucket: "day" | "hour"; timeZone: string } = { since: daysToSince(days), bucket, timeZone: parseTimeZone(query.tz) };
    const analytics = (await ensureRequestApplications(request, options)).analytics;
    const rows = await analytics.aggregateTokenTrend(input);
    return ok(rows, "获取 token 趋势成功");
  });

  app.get("/analytics/model-usage", async (request) => {
    const query = request.query as RangeQuery;
    const days = parseDays(query.days, DEFAULT_MODEL_DAYS);
    const input = { since: daysToSince(days) };
    const analytics = (await ensureRequestApplications(request, options)).analytics;
    const rows = await analytics.aggregateModelUsage(input);
    return ok(rows, "获取模型用量成功");
  });

  app.get("/analytics/activity-heatmap", async (request) => {
    const query = request.query as RangeQuery;
    const days = parseDays(query.days, DEFAULT_HEATMAP_DAYS);
    const input = { since: daysToSince(days), timeZone: parseTimeZone(query.tz) };
    const analytics = (await ensureRequestApplications(request, options)).analytics;
    const rows = await analytics.aggregateActivityHeatmap(input);
    return ok(rows, "获取活跃热力图成功");
  });

  app.get("/analytics/daily-activity", async (request) => {
    const query = request.query as RangeQuery;
    const days = parseDays(query.days, DEFAULT_DAILY_DAYS);
    const input = { since: daysToSince(days), timeZone: parseTimeZone(query.tz) };
    const analytics = (await ensureRequestApplications(request, options)).analytics;
    const rows = await analytics.aggregateDailyActivity(input);
    return ok(rows, "获取每日活跃度成功");
  });
};
