import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import type { ConversationStore } from "../../src/contracts/conversation-store/index.js";

function makeStore(): ConversationStore {
  return createConversationStore({ dbPath: ":memory:" });
}

describe("MetricOps", () => {
  it("aggregates metrics grouped by agent (counts / avg / token / tool / error / time range)", () => {
    const store = makeStore();
    store.insertMetric({
      agentName: "agent-a",
      sessionId: "s1",
      runId: "r1",
      executionKind: "agent_stream",
      status: "completed",
      durationMs: 1000,
      tokenIn: 100,
      tokenOut: 50,
      toolUsage: { execute_bash: 1 },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    });
    store.insertMetric({
      agentName: "agent-a",
      sessionId: "s1",
      runId: "r2",
      executionKind: "agent_stream",
      status: "failed",
      durationMs: 3000,
      tokenIn: 200,
      tokenOut: 100,
      toolUsage: { execute_bash: 1, search: 2 },
      errorType: "timeout",
      startedAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:00:03.000Z",
    });
    store.insertMetric({
      agentName: "agent-b",
      sessionId: "s2",
      runId: "r3",
      executionKind: "execute",
      status: "completed",
      durationMs: 500,
      tokenIn: 50,
      tokenOut: 25,
      toolUsage: { search: 1 },
      startedAt: "2026-01-03T00:00:00.000Z",
    });

    const summaries = store.aggregateMetrics();
    expect(summaries).toHaveLength(2);

    const a = summaries.find((s) => s.agent_name === "agent-a")!;
    expect(a.total_calls).toBe(2);
    expect(a.success_count).toBe(1);
    expect(a.failure_count).toBe(1);
    expect(a.success_rate).toBe(0.5);
    expect(a.avg_duration_ms).toBe(2000);
    expect(a.avg_tokens).toBe(225);
    expect(a.first_call).toBe("2026-01-01T00:00:00.000Z");
    expect(a.last_call).toBe("2026-01-02T00:00:00.000Z");
    expect(a.tool_usage).toEqual({ execute_bash: 2, search: 2 });
    expect(a.error_distribution).toEqual({ timeout: 1 });

    const b = summaries.find((s) => s.agent_name === "agent-b")!;
    expect(b.total_calls).toBe(1);
    expect(b.success_rate).toBe(1);
    expect(b.avg_tokens).toBe(75);
  });

  it("filters aggregation by agent name", () => {
    const store = makeStore();
    store.insertMetric({ agentName: "a", executionKind: "agent_stream", status: "completed", durationMs: 100, startedAt: "2026-01-01T00:00:00.000Z" });
    store.insertMetric({ agentName: "b", executionKind: "agent_stream", status: "completed", durationMs: 200, startedAt: "2026-01-01T00:00:00.000Z" });
    const onlyA = store.aggregateMetrics("a");
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].agent_name).toBe("a");
  });

  it("resets all metrics", () => {
    const store = makeStore();
    store.insertMetric({ agentName: "a", executionKind: "agent_stream", status: "completed", durationMs: 100, startedAt: "2026-01-01T00:00:00.000Z" });
    store.insertMetric({ agentName: "b", executionKind: "agent_stream", status: "completed", durationMs: 200, startedAt: "2026-01-01T00:00:00.000Z" });
    const all = store.resetMetrics();
    expect(all.deleted).toBe(2);
    expect(store.aggregateMetrics()).toHaveLength(0);
  });

  it("resets metrics for a single agent only", () => {
    const store = makeStore();
    store.insertMetric({ agentName: "a", executionKind: "agent_stream", status: "completed", durationMs: 100, startedAt: "2026-01-01T00:00:00.000Z" });
    store.insertMetric({ agentName: "b", executionKind: "agent_stream", status: "completed", durationMs: 200, startedAt: "2026-01-01T00:00:00.000Z" });
    const one = store.resetMetrics("a");
    expect(one.deleted).toBe(1);
    const summaries = store.aggregateMetrics();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].agent_name).toBe("b");
  });

  it("counts interrupted as failure, not success", () => {
    const store = makeStore();
    store.insertMetric({ agentName: "a", executionKind: "agent_stream", status: "interrupted", durationMs: 100, startedAt: "2026-01-01T00:00:00.000Z" });
    const [summary] = store.aggregateMetrics();
    expect(summary.failure_count).toBe(1);
    expect(summary.success_count).toBe(0);
    expect(summary.success_rate).toBe(0);
  });
});
