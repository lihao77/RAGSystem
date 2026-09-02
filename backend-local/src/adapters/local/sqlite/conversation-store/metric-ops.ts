import { randomUUID } from "node:crypto";
import type { ConversationDb } from "./shared/db.js";
import { parseJsonObject, stringifyJson } from "./helpers.js";
import type { AgentMetricSummary, DailyActivityPoint, HeatmapPoint, ModelUsagePoint, TokenTrendPoint } from "@ragsystem/backend-core/contracts/conversation-store/index.js";

/** agent_call_metrics 表行。 */
export interface AgentCallMetricRow {
  metric_id: string;
  agent_name: string;
  model: string | null;
  session_id: string | null;
  run_id: string | null;
  task_id: string | null;
  execution_kind: string;
  status: string;
  duration_ms: number;
  token_in: number;
  token_out: number;
  tool_usage: string;
  error_type: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * agent_call_metrics 聚合根:每次 agent run 一条明细 + 按 agent 聚合。
 * 与 resources/runs 同库同连接(backend ConversationDb)。
 */
export class MetricOps {
  constructor(private readonly db: ConversationDb) {}

  insertMetric(input: {
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
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO agent_call_metrics
          (metric_id, agent_name, model, session_id, run_id, task_id, execution_kind, status,
           duration_ms, token_in, token_out, tool_usage, error_type, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        randomUUID(),
        input.agentName,
        input.model ?? null,
        input.sessionId ?? null,
        input.runId ?? null,
        input.taskId ?? null,
        input.executionKind,
        input.status,
        input.durationMs,
        input.tokenIn ?? 0,
        input.tokenOut ?? 0,
        stringifyJson(input.toolUsage ?? {}),
        input.errorType ?? null,
        input.startedAt,
        input.finishedAt ?? null,
      );
  }

  /**
   * 按 agent 聚合(可选过滤指定 agent)。tool_usage/error_distribution 是 JSON,TS 层合并;
   * 标量 TS 层累加。指标表每次 run 一行、/metrics 低频(前端 10s 刷新),
   * 全表读 + 内存聚合性能够用;若后续量级增长再加 rollup 表或时间窗口。
   */
  aggregateMetrics(agentName?: string | null): AgentMetricSummary[] {
    const rows = agentName
      ? (this.db
          .prepare("SELECT * FROM agent_call_metrics WHERE agent_name=? ORDER BY started_at ASC")
          .all(agentName) as unknown as AgentCallMetricRow[])
      : (this.db
          .prepare("SELECT * FROM agent_call_metrics ORDER BY started_at ASC")
          .all() as unknown as AgentCallMetricRow[]);
    const byAgent = new Map<string, Accumulator>();
    for (const row of rows) {
      const acc = byAgent.get(row.agent_name) ?? createAccumulator(row.agent_name);
      byAgent.set(row.agent_name, acc);
      acc.totalCalls += 1;
      if (row.status === "completed") {
        acc.successCount += 1;
      } else {
        acc.failureCount += 1;
      }
      acc.durationSum += row.duration_ms;
      acc.tokenSum += row.token_in + row.token_out;
      if (!acc.firstCall || row.started_at < acc.firstCall) {
        acc.firstCall = row.started_at;
      }
      if (!acc.lastCall || row.started_at > acc.lastCall) {
        acc.lastCall = row.started_at;
      }
      mergeToolUsage(acc.toolUsage, row.tool_usage);
      if (row.error_type) {
        acc.errorDistribution[row.error_type] = (acc.errorDistribution[row.error_type] ?? 0) + 1;
      }
    }
    return Array.from(byAgent.values()).map(toSummary);
  }

  resetMetrics(agentName?: string | null): { deleted: number } {
    const result = agentName
      ? this.db.prepare("DELETE FROM agent_call_metrics WHERE agent_name=?").run(agentName)
      : this.db.prepare("DELETE FROM agent_call_metrics").run();
    return { deleted: Number(result.changes) };
  }

  aggregateTokenTrend(opts: { since?: string | null; bucket: "day" | "hour"; timeZone?: string | null }): TokenTrendPoint[] {
    const since = opts.since ?? "1970-01-01T00:00:00.000Z";
    const rows = this.db
      .prepare("SELECT started_at, token_in, token_out FROM agent_call_metrics WHERE started_at >= ?")
      .all(since) as Array<{ started_at: string; token_in: number; token_out: number }>;
    const dayKey = createDayKeyFormatter(opts.timeZone);
    const hourKey = createHourFormatter(opts.timeZone);
    const buckets = new Map<string, { token_in: number; token_out: number; calls: number }>();
    for (const row of rows) {
      const date = parseMetricDate(row.started_at);
      if (!date) continue;
      const ts = opts.bucket === "hour" ? `${dayKey(date)}T${hourKey(date)}:00` : dayKey(date);
      const acc = buckets.get(ts) ?? { token_in: 0, token_out: 0, calls: 0 };
      acc.token_in += row.token_in;
      acc.token_out += row.token_out;
      acc.calls += 1;
      buckets.set(ts, acc);
    }
    return [...buckets.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([ts, acc]) => ({ ts, token_in: acc.token_in, token_out: acc.token_out, calls: acc.calls }));
  }

  aggregateModelUsage(opts: { since?: string | null }): ModelUsagePoint[] {
    const since = opts.since ?? "1970-01-01T00:00:00.000Z";
    const rows = this.db
      .prepare(
        `SELECT COALESCE(model, '未知') AS model,
                COALESCE(token_in + token_out, 0) AS tokens
         FROM agent_call_metrics WHERE started_at >= ?`,
      )
      .all(since) as Array<{ model: string; tokens: number }>;
    const buckets = new Map<string, { tokens: number; calls: number }>();
    for (const row of rows) {
      const acc = buckets.get(row.model) ?? { tokens: 0, calls: 0 };
      acc.tokens += row.tokens;
      acc.calls += 1;
      buckets.set(row.model, acc);
    }
    return [...buckets.entries()]
      .sort((left, right) => right[1].tokens - left[1].tokens || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      .map(([model, acc]) => ({ model, tokens: acc.tokens, calls: acc.calls }));
  }

  aggregateActivityHeatmap(opts: { since?: string | null; timeZone?: string | null }): HeatmapPoint[] {
    const since = opts.since ?? "1970-01-01T00:00:00.000Z";
    const rows = this.db
      .prepare("SELECT started_at FROM agent_call_metrics WHERE started_at >= ?")
      .all(since) as Array<{ started_at: string }>;
    const weekdayOf = createWeekdayFormatter(opts.timeZone);
    const hourKey = createHourFormatter(opts.timeZone);
    const buckets = new Map<string, { weekday: number; hour: number; calls: number }>();
    for (const row of rows) {
      const date = parseMetricDate(row.started_at);
      if (!date) continue;
      const weekday = weekdayOf(date);
      const hour = Number(hourKey(date));
      if (weekday === null || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      const key = `${weekday}-${hour}`;
      const acc = buckets.get(key) ?? { weekday, hour, calls: 0 };
      acc.calls += 1;
      buckets.set(key, acc);
    }
    return [...buckets.values()].sort((left, right) => left.weekday - right.weekday || left.hour - right.hour);
  }

  aggregateDailyActivity(opts: { since?: string | null; timeZone?: string | null }): DailyActivityPoint[] {
    const since = opts.since ?? "1970-01-01T00:00:00.000Z";
    const rows = this.db
      .prepare("SELECT started_at FROM agent_call_metrics WHERE started_at >= ?")
      .all(since) as Array<{ started_at: string }>;
    const dayKey = createDayKeyFormatter(opts.timeZone);
    const buckets = new Map<string, number>();
    for (const row of rows) {
      const date = parseMetricDate(row.started_at);
      if (!date) continue;
      buckets.set(dayKey(date), (buckets.get(dayKey(date)) ?? 0) + 1);
    }
    return [...buckets.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([date, calls]) => ({ date, calls }));
  }
}

/**
 * 日/小时分桶在 TS 层按 IANA 时区墙钟切（SQLite strftime 只支持 UTC/localtime，
 * 任意时区 + 夏令时只能靠 Intl）。指标表每次 run 一行、量级小，全表读后内存分桶性能够用。
 */
function createDayKeyFormatter(timeZone?: string | null): (date: Date) => string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? undefined, year: "numeric", month: "2-digit", day: "2-digit" });
  return (date) => fmt.format(date);
}

function createHourFormatter(timeZone?: string | null): (date: Date) => string {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone ?? undefined, hour: "2-digit", hourCycle: "h23" });
  return (date) => fmt.format(date);
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function createWeekdayFormatter(timeZone?: string | null): (date: Date) => number | null {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? undefined, weekday: "short" });
  return (date) => WEEKDAY_INDEX[fmt.format(date)] ?? null;
}

function parseMetricDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

interface Accumulator {
  agentName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  durationSum: number;
  tokenSum: number;
  firstCall: string | null;
  lastCall: string | null;
  toolUsage: Record<string, number>;
  errorDistribution: Record<string, number>;
}

function createAccumulator(agentName: string): Accumulator {
  return {
    agentName,
    totalCalls: 0,
    successCount: 0,
    failureCount: 0,
    durationSum: 0,
    tokenSum: 0,
    firstCall: null,
    lastCall: null,
    toolUsage: {},
    errorDistribution: {},
  };
}

function toSummary(acc: Accumulator): AgentMetricSummary {
  return {
    agent_name: acc.agentName,
    total_calls: acc.totalCalls,
    success_count: acc.successCount,
    failure_count: acc.failureCount,
    success_rate: acc.totalCalls > 0 ? acc.successCount / acc.totalCalls : 0,
    avg_duration_ms: acc.totalCalls > 0 ? Math.round(acc.durationSum / acc.totalCalls) : 0,
    avg_tokens: acc.totalCalls > 0 ? Math.round(acc.tokenSum / acc.totalCalls) : 0,
    first_call: acc.firstCall,
    last_call: acc.lastCall,
    tool_usage: acc.toolUsage,
    error_distribution: acc.errorDistribution,
  };
}

function mergeToolUsage(target: Record<string, number>, json: string): void {
  const parsed = parseJsonObject(json);
  if (!parsed) {
    return;
  }
  for (const [tool, count] of Object.entries(parsed)) {
    if (typeof count === "number") {
      target[tool] = (target[tool] ?? 0) + count;
    }
  }
}
