import { describe, expect, it, vi } from "vitest";

import { SaaSAgentMetricsStore } from "../../../../src/adapters/saas/postgres/saas-agent-metrics-store.js";
import { SaaSPermissionPolicyStore } from "../../../../src/adapters/saas/postgres/saas-permission-policy-store.js";
import { PermissionPolicyService } from "../../../../src/services/runtime/permission-policy-service.js";
import { AgentMetricsCollector } from "../../../../src/services/agent/metrics/metrics-collector.js";

describe("SaaS runtime port adapters", () => {
  it("loads permission mode from the tenant-bound PostgreSQL session snapshot", async () => {
    const getSession = vi.fn().mockResolvedValue({
      session_id: "s-1",
      tenant_id: "tenant-a",
      user_id: "u-1",
      permission_mode: "relaxed",
      metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const store = new SaaSPermissionPolicyStore("tenant-a", { getSession });
    const service = new PermissionPolicyService(store);
    expect(() => service.getEffectivePolicy("s-1")).toThrow("not prepared");
    await service.prepareSession("s-1");
    expect(service.getEffectivePolicy("s-1").mode).toBe("relaxed");
    expect(getSession).toHaveBeenCalledWith("s-1");
  });

  it("does not expose another tenant's permission mode", async () => {
    const store = new SaaSPermissionPolicyStore("tenant-a", {
      getSession: vi.fn().mockResolvedValue({
        session_id: "s-1", tenant_id: "tenant-b", user_id: null, permission_mode: "dangerously_skip_permissions",
        metadata: {}, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      }),
    });
    await store.prepareSession("s-1");
    expect(store.getSession("s-1")).toEqual({ permission_mode: null });
  });

  it("binds every metrics operation to its tenant", async () => {
    const analytics = {
      insertMetric: vi.fn().mockResolvedValue(undefined),
      aggregateMetrics: vi.fn().mockResolvedValue([]),
      resetMetrics: vi.fn().mockResolvedValue({ deleted: 2 }),
    };
    const store = new SaaSAgentMetricsStore("tenant-a", analytics);
    const collector = new AgentMetricsCollector(store);
    await collector.recordRun({
      agentName: "agent-a", executionKind: "agent_stream", status: "completed", durationMs: 1,
      sessionId: "s-1", runId: "r-1", taskId: null, tokenIn: 0, tokenOut: 0,
      toolUsage: {}, errorType: null, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null,
    });
    await collector.getSystemMetrics("agent-a");
    await collector.reset();
    expect(analytics.insertMetric).toHaveBeenCalledWith("tenant-a", expect.any(Object));
    expect(analytics.aggregateMetrics).toHaveBeenCalledWith("tenant-a", "agent-a");
    expect(analytics.resetMetrics).toHaveBeenCalledWith("tenant-a", undefined);
  });
});
