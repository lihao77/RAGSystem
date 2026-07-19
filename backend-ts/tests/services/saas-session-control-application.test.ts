import { describe, expect, it, vi } from "vitest";

import { createTenantId } from "../../src/identity/types.js";
import { SaaSSessionControlApplication } from "../../src/services/runtime/saas-session-control-application.js";

describe("SaaSSessionControlApplication", () => {
  it("只中断当前租户的 suspended runs 并取消 durable interactions", async () => {
    const conversations = {
      getSession: vi.fn().mockResolvedValue({ tenant_id: "tnt_a" }),
    };
    const runs = {
      interruptSuspendedRuns: vi.fn().mockResolvedValue([
        { run_id: "run-root", parent_run_id: null },
      ]),
    };
    const pending = { cancelPendingInteractions: vi.fn().mockResolvedValue(2) };
    const application = new SaaSSessionControlApplication(
      createTenantId("tnt_a"),
      conversations as never,
      runs as never,
      pending as never,
    );

    await expect(application.interruptSuspendedSession("session-a")).resolves.toEqual([
      { runId: "run-root", parentRunId: null },
    ]);
    expect(runs.interruptSuspendedRuns).toHaveBeenCalledWith("tnt_a", "session-a");
    expect(pending.cancelPendingInteractions).toHaveBeenCalledWith("session-a");
  });

  it("拒绝跨租户 session 且不修改运行状态", async () => {
    const runs = { interruptSuspendedRuns: vi.fn() };
    const pending = { cancelPendingInteractions: vi.fn() };
    const application = new SaaSSessionControlApplication(
      createTenantId("tnt_a"),
      { getSession: vi.fn().mockResolvedValue({ tenant_id: "tnt_b" }) } as never,
      runs as never,
      pending as never,
    );

    await expect(application.interruptSuspendedSession("session-b")).resolves.toEqual([]);
    expect(runs.interruptSuspendedRuns).not.toHaveBeenCalled();
    expect(pending.cancelPendingInteractions).not.toHaveBeenCalled();
  });
});
