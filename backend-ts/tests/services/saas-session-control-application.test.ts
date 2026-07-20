import { describe, expect, it, vi } from "vitest";

import { SaaSSessionControlApplication } from "../../src/adapters/saas/application/execution/saas-session-control-application.js";

describe("SaaSSessionControlApplication", () => {
  it("delegates session interruption to the tenant-bound atomic operation", async () => {
    const interruptSession = vi.fn().mockResolvedValue({
      interruptedRuns: [{ runId: "run-root", parentRunId: null }],
      cancelledInteractions: 2,
      records: [],
    });
    const application = new SaaSSessionControlApplication({
      operations: { interruptSession },
    } as never);

    await expect(application.interruptSuspendedSession("session-a")).resolves.toEqual([
      { runId: "run-root", parentRunId: null },
    ]);
    expect(interruptSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-a" }));
  });
});
