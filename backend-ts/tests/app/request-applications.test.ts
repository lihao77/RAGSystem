import { describe, expect, it, vi } from "vitest";

import { createRequestApplications } from "../../src/app/request-applications.js";

describe("createRequestApplications", () => {
  it("selects tenant-bound applications and uses the runtime interaction coordinator", async () => {
    const sessions = {};
    const memory = {};
    const artifacts = {};
    const analytics = {};
    const monitoring = {};
    const executionRead = {};
    const interactions = {};
    const executionCore = {};
    const options = {
      resolveSessionApplication: vi.fn().mockResolvedValue(sessions),
      resolveMemoryApplication: vi.fn().mockResolvedValue(memory),
      resolveArtifactApplication: vi.fn().mockResolvedValue(artifacts),
      resolveAnalytics: vi.fn().mockResolvedValue(analytics),
      resolveMonitoringApplication: vi.fn().mockResolvedValue(monitoring),
      resolveExecutionRead: vi.fn().mockResolvedValue(executionRead),
    };

    await expect(createRequestApplications({
      container: { agentExecution: executionCore, interactionCoordinator: interactions },
    } as never, options as never)).resolves.toEqual({
      sessions,
      memory,
      artifacts,
      analytics,
      monitoring,
      executionRead,
      interactions,
      execution: expect.anything(),
    });
    expect(options.resolveExecutionRead).toHaveBeenCalledOnce();
  });

  it("rejects an undefined SaaS resolver instead of falling back to Local storage", async () => {
    await expect(createRequestApplications({
      identity: { tenantId: "tnt_saas" },
      container: { deploymentKind: "saas" },
    } as never, {
      resolveSessionApplication: vi.fn().mockResolvedValue(undefined),
    } as never)).rejects.toThrow("SaaS session application resolver returned no implementation");
  });
});
