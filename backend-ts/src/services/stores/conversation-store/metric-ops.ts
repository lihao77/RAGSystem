import { randomUUID } from "node:crypto";
import type { ConversationDb } from "./shared/db.js";
import { parseJsonObject, stringifyJson } from "./helpers.js";
import type { AgentMetricSummary } from "../../../contracts/conversation-store/index.js";

/** agent_call_metrics 表行。 */
export interface AgentCallMetricRow {
  metric_id: string;
  agent_name: string;
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
          (metric_id, agent_name, session_id, run_id, task_id, execution_kind, status,
           duration_ms, token_in, token_out, tool_usage, error_type, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        randomUUID(),
        input.agentName,
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
