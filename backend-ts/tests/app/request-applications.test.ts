import { describe, expect, it, vi } from "vitest";

import { createRequestApplications } from "../../src/app/request-applications.js";

describe("createRequestApplications", () => {
  it("selects tenant-bound execution and interaction applications once", async () => {
    const sessions = {};
    const memory = {};
    const artifacts = {};
    const analytics = {};
    const monitoring = {};
    const executionRead = {};
    const interactions = {};
    const executionCore = {};
    const resumeExecutor = {};
    const options = {
      resolveSessionApplication: vi.fn().mockResolvedValue(sessions),
      resolveMemoryApplication: vi.fn().mockResolvedValue(memory),
      resolveArtifactApplication: vi.fn().mockResolvedValue(artifacts),
      resolveAnalytics: vi.fn().mockResolvedValue(analytics),
      resolveMonitoringApplication: vi.fn().mockResolvedValue(monitoring),
      resolveSaaSAgentReadApplication: vi.fn().mockResolvedValue(executionRead),
      resolveSaaSInteractionRecovery: vi.fn().mockResolvedValue(interactions),
    };

    await expect(createRequestApplications({
      container: { agentExecution: executionCore, resumeExecutor },
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
    expect(options.resolveSaaSAgentReadApplication).toHaveBeenCalledOnce();
    expect(options.resolveSaaSInteractionRecovery).toHaveBeenCalledOnce();
  });
});
