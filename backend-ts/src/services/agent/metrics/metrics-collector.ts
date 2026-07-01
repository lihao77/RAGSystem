import type { AgentMetricSummary } from "../../../contracts/conversation-store/index.js";

/** metrics 写入/聚合端口(MetricOps 的窄投影,便于测试与解耦)。 */
interface MetricStorePort {
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
  }): void;
  aggregateMetrics(agentName?: string | null): AgentMetricSummary[];
  resetMetrics(agentName?: string | null): { deleted: number };
}

/** 单次 agent run 的指标采集载荷(由 executeRun 在终态填充后落库)。 */
export interface AgentRunMetricPayload {
  agentName: string;
  sessionId: string | null;
  runId: string | null;
  taskId: string | null;
  executionKind: string;
  status: string;
  durationMs: number;
  tokenIn: number;
  tokenOut: number;
  toolUsage: Record<string, number>;
  errorType: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 全部 agent 的系统级指标(对齐前端 AgentMonitor 系统卡片 + agents 列表)。 */
export interface SystemMetrics {
  total_agents: number;
  total_calls: number;
  avg_duration_ms: number;
  overall_success_rate: number;
  agents: Record<string, AgentMetricSummary>;
}

/**
 * 智能体性能指标采集器(业务层):封装"终态落库"与"按 agent 聚合返回前端结构"。
 * 数据层是 MetricOps;本类负责 payload 组装 + 系统级聚合(总调用/加权平均耗时/总成功率)。
 */
export class AgentMetricsCollector {
  constructor(private readonly store: MetricStorePort) {}

  recordRun(payload: AgentRunMetricPayload): void {
    this.store.insertMetric(payload);
  }

  /**
   * 返回监控指标。无 agent_name:系统级 + agents Record;
   * 指定 agent_name:铺平返回该 agent 单对象(无数据返零值,对齐前端 agent_metrics || value 取数)。
   */
  getSystemMetrics(agentName?: string | null): SystemMetrics | AgentMetricSummary {
    if (agentName) {
      const summaries = this.store.aggregateMetrics(agentName);
      return summaries[0] ?? zeroSummary(agentName);
    }
    const summaries = this.store.aggregateMetrics();
    const agents: Record<string, AgentMetricSummary> = {};
    let totalCalls = 0;
    let successTotal = 0;
    let durationSum = 0;
    for (const summary of summaries) {
      agents[summary.agent_name] = summary;
      totalCalls += summary.total_calls;
      successTotal += summary.success_count;
      durationSum += summary.avg_duration_ms * summary.total_calls;
    }
    return {
      total_agents: summaries.length,
      total_calls: totalCalls,
      avg_duration_ms: totalCalls > 0 ? Math.round(durationSum / totalCalls) : 0,
      overall_success_rate: totalCalls > 0 ? successTotal / totalCalls : 0,
      agents,
    };
  }

  reset(agentName?: string | null): { deleted: number } {
    return this.store.resetMetrics(agentName);
  }
}

function zeroSummary(agentName: string): AgentMetricSummary {
  return {
    agent_name: agentName,
    total_calls: 0,
    success_count: 0,
    failure_count: 0,
    success_rate: 0,
    avg_duration_ms: 0,
    avg_tokens: 0,
    first_call: null,
    last_call: null,
    tool_usage: {},
    error_distribution: {},
  };
}
