import { randomUUID } from "node:crypto";

import type {
  AgentMetricSummary,
  DailyActivityPoint,
  HeatmapPoint,
  ModelUsagePoint,
  TokenTrendPoint,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { PostgresExecutor } from "./postgres-executor.js";
import type { AsyncAgentMetricsRepository, AsyncAnalyticsRepository } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";
export type { AsyncAnalyticsRepository } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";

function number(value: unknown): number {
  return Number(value ?? 0);
}

/** Tenant-filtered PostgreSQL analytics data plane. */
export class PostgresAnalyticsRepository implements AsyncAnalyticsRepository, AsyncAgentMetricsRepository {
  constructor(private readonly executor: PostgresExecutor) {}

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

  async aggregateMetrics(tenantId: string, agentName?: string | null): Promise<AgentMetricSummary[]> {
    const params: unknown[] = [tenantId];
    const agentFilter = agentName ? " AND agent_name=$2" : "";
    if (agentName) params.push(agentName);
    const result = await this.executor.query(`SELECT agent_name, status, duration_ms, token_in, token_out,
        tool_usage, error_type, started_at
      FROM saas_agent_call_metrics
      WHERE tenant_id=$1${agentFilter}
      ORDER BY started_at ASC`, params);
    return aggregateMetricRows(result.rows);
  }

  async resetMetrics(tenantId: string, agentName?: string | null): Promise<{ deleted: number }> {
    const result = agentName
      ? await this.executor.query(
          "DELETE FROM saas_agent_call_metrics WHERE tenant_id=$1 AND agent_name=$2",
          [tenantId, agentName],
        )
      : await this.executor.query("DELETE FROM saas_agent_call_metrics WHERE tenant_id=$1", [tenantId]);
    return { deleted: Number(result.rowCount ?? 0) };
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

interface MetricAccumulator {
  agentName: string;
  totalCalls: number;
  successCount: number;
  durationSum: number;
  tokenSum: number;
  firstCall: string | null;
  lastCall: string | null;
  toolUsage: Record<string, number>;
  errorDistribution: Record<string, number>;
}

function aggregateMetricRows(rows: Record<string, unknown>[]): AgentMetricSummary[] {
  const byAgent = new Map<string, MetricAccumulator>();
  for (const row of rows) {
    const agentName = String(row.agent_name);
    const current = byAgent.get(agentName) ?? createMetricAccumulator(agentName);
    byAgent.set(agentName, current);
    current.totalCalls += 1;
    if (row.status === "completed") current.successCount += 1;
    current.durationSum += number(row.duration_ms);
    current.tokenSum += number(row.token_in) + number(row.token_out);
    const startedAt = new Date(String(row.started_at)).toISOString();
    current.firstCall ??= startedAt;
    current.lastCall = startedAt;
    mergeCounts(current.toolUsage, row.tool_usage);
    if (typeof row.error_type === "string" && row.error_type) {
      current.errorDistribution[row.error_type] = (current.errorDistribution[row.error_type] ?? 0) + 1;
    }
  }
  return Array.from(byAgent.values(), (item) => ({
    agent_name: item.agentName,
    total_calls: item.totalCalls,
    success_count: item.successCount,
    failure_count: item.totalCalls - item.successCount,
    success_rate: item.totalCalls > 0 ? item.successCount / item.totalCalls : 0,
    avg_duration_ms: item.totalCalls > 0 ? Math.round(item.durationSum / item.totalCalls) : 0,
    avg_tokens: item.totalCalls > 0 ? Math.round(item.tokenSum / item.totalCalls) : 0,
    first_call: item.firstCall,
    last_call: item.lastCall,
    tool_usage: item.toolUsage,
    error_distribution: item.errorDistribution,
  }));
}

function createMetricAccumulator(agentName: string): MetricAccumulator {
  return {
    agentName,
    totalCalls: 0,
    successCount: 0,
    durationSum: 0,
    tokenSum: 0,
    firstCall: null,
    lastCall: null,
    toolUsage: {},
    errorDistribution: {},
  };
}

function mergeCounts(target: Record<string, number>, value: unknown): void {
  const source = typeof value === "string" ? parseJsonObject(value) : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [key, count] of Object.entries(source)) {
    if (typeof count === "number") target[key] = (target[key] ?? 0) + count;
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
