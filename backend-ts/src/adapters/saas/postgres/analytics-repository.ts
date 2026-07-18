import { randomUUID } from "node:crypto";

import type {
  DailyActivityPoint,
  HeatmapPoint,
  ModelUsagePoint,
  TokenTrendPoint,
} from "../../../contracts/conversation-store/index.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

export interface AsyncAnalyticsRepository {
  insertMetric(tenantId: string, input: {
    agentName: string;
    model?: string;
    sessionId?: string | null;
    runId?: string | null;
    taskId?: string | null;
    executionKind: string;
    status: string;
    durationMs: number;
    tokenIn?: number;
    tokenOut?: number;
    toolUsage?: Record<string, number>;
    errorType?: string | null;
    startedAt: string;
    finishedAt?: string | null;
  }): Promise<void>;
  aggregateTokenTrend(tenantId: string, input: { since: string; bucket: "day" | "hour" }): Promise<TokenTrendPoint[]>;
  aggregateModelUsage(tenantId: string, input: { since: string }): Promise<ModelUsagePoint[]>;
  aggregateActivityHeatmap(tenantId: string, input: { since: string }): Promise<HeatmapPoint[]>;
  aggregateDailyActivity(tenantId: string, input: { since: string }): Promise<DailyActivityPoint[]>;
}

function number(value: unknown): number {
  return Number(value ?? 0);
}

/** Tenant-filtered PostgreSQL analytics data plane. */
export class PostgresAnalyticsRepository implements AsyncAnalyticsRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async insertMetric(tenantId: string, input: Parameters<AsyncAnalyticsRepository["insertMetric"]>[1]): Promise<void> {
    await this.executor.query(`INSERT INTO saas_agent_call_metrics
      (metric_id, tenant_id, agent_name, model, session_id, run_id, task_id, execution_kind, status,
       duration_ms, token_in, token_out, tool_usage, error_type, started_at, finished_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`, [
      randomUUID(), tenantId, input.agentName, input.model ?? null, input.sessionId ?? null,
      input.runId ?? null, input.taskId ?? null, input.executionKind, input.status,
      input.durationMs, input.tokenIn ?? 0, input.tokenOut ?? 0,
      JSON.stringify(input.toolUsage ?? {}), input.errorType ?? null, input.startedAt, input.finishedAt ?? null,
    ]);
  }

  async aggregateTokenTrend(tenantId: string, input: { since: string; bucket: "day" | "hour" }): Promise<TokenTrendPoint[]> {
    const format = input.bucket === "hour" ? "YYYY-MM-DD\"T\"HH24:00" : "YYYY-MM-DD";
    const result = await this.executor.query(`SELECT to_char(started_at AT TIME ZONE 'UTC', $3) AS ts,
        COALESCE(SUM(token_in), 0)::text AS token_in, COALESCE(SUM(token_out), 0)::text AS token_out,
        COUNT(*)::text AS calls
      FROM saas_agent_call_metrics
      WHERE tenant_id=$1 AND started_at >= $2::timestamptz
      GROUP BY 1 ORDER BY 1 ASC`, [tenantId, input.since, format]);
    return result.rows.map((row) => ({ ts: String(row.ts), token_in: number(row.token_in), token_out: number(row.token_out), calls: number(row.calls) }));
  }

  async aggregateModelUsage(tenantId: string, input: { since: string }): Promise<ModelUsagePoint[]> {
    const result = await this.executor.query(`SELECT COALESCE(model, '未知') AS model,
        COALESCE(SUM(token_in + token_out), 0)::text AS tokens, COUNT(*)::text AS calls
      FROM saas_agent_call_metrics
      WHERE tenant_id=$1 AND started_at >= $2::timestamptz
      GROUP BY model ORDER BY SUM(token_in + token_out) DESC, model ASC`, [tenantId, input.since]);
    return result.rows.map((row) => ({ model: String(row.model), tokens: number(row.tokens), calls: number(row.calls) }));
  }

  async aggregateActivityHeatmap(tenantId: string, input: { since: string }): Promise<HeatmapPoint[]> {
    const result = await this.executor.query(`SELECT EXTRACT(DOW FROM started_at AT TIME ZONE 'UTC')::integer AS weekday,
        EXTRACT(HOUR FROM started_at AT TIME ZONE 'UTC')::integer AS hour, COUNT(*)::text AS calls
      FROM saas_agent_call_metrics
      WHERE tenant_id=$1 AND started_at >= $2::timestamptz
      GROUP BY 1, 2 ORDER BY 1, 2`, [tenantId, input.since]);
    return result.rows.map((row) => ({ weekday: number(row.weekday), hour: number(row.hour), calls: number(row.calls) }));
  }

  async aggregateDailyActivity(tenantId: string, input: { since: string }): Promise<DailyActivityPoint[]> {
    const result = await this.executor.query(`SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        COUNT(*)::text AS calls
      FROM saas_agent_call_metrics
      WHERE tenant_id=$1 AND started_at >= $2::timestamptz
      GROUP BY 1 ORDER BY 1 ASC`, [tenantId, input.since]);
    return result.rows.map((row) => ({ date: String(row.date), calls: number(row.calls) }));
  }
}
