import { describe, expect, it, vi } from "vitest";

import { PostgresAnalyticsRepository } from "../../../../src/adapters/saas/postgres/analytics-repository.js";

describe("PostgresAnalyticsRepository", () => {
  it("scopes every analytics query to the requested tenant and maps numeric aggregates", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ts: "2026-07-18", token_in: "120", token_out: "30", calls: "2" }] })
      .mockResolvedValueOnce({ rows: [{ model: "gpt-5", tokens: "150", calls: "2" }] })
      .mockResolvedValueOnce({ rows: [{ weekday: 6, hour: 7, calls: "2" }] })
      .mockResolvedValueOnce({ rows: [{ date: "2026-07-18", calls: "2" }] });
    const repository = new PostgresAnalyticsRepository({ query } as never);
    const since = "2026-07-01T00:00:00.000Z";

    await expect(repository.aggregateTokenTrend("tenant-a", { since, bucket: "day" })).resolves.toEqual([
      { ts: "2026-07-18", token_in: 120, token_out: 30, calls: 2 },
    ]);
    await expect(repository.aggregateModelUsage("tenant-a", { since })).resolves.toEqual([
      { model: "gpt-5", tokens: 150, calls: 2 },
    ]);
    await expect(repository.aggregateActivityHeatmap("tenant-a", { since })).resolves.toEqual([
      { weekday: 6, hour: 7, calls: 2 },
    ]);
    await expect(repository.aggregateDailyActivity("tenant-a", { since })).resolves.toEqual([
      { date: "2026-07-18", calls: 2 },
    ]);

    for (const call of query.mock.calls) {
      expect(call[0]).toContain("tenant_id=$1");
      expect(call[1]?.[0]).toBe("tenant-a");
      expect(call[1]?.[1]).toBe(since);
    }
  });

  it("writes a metric with tenant identity and JSONB tool usage", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const repository = new PostgresAnalyticsRepository({ query } as never);

    await repository.insertMetric("tenant-b", {
      agentName: "agent-a", model: "gpt-5", executionKind: "agent_stream", status: "completed",
      durationMs: 50, tokenIn: 7, tokenOut: 3, toolUsage: { search: 1 }, startedAt: "2026-07-18T00:00:00.000Z",
    });

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]?.[1]).toBe("tenant-b");
    expect(query.mock.calls[0]?.[1]?.[12]).toBe('{"search":1}');
  });
});
