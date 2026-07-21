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
    const execution = {};
    const providers = {};
    const mcp = {};
    const options = {
      resolveSessionApplication: vi.fn().mockResolvedValue(sessions),
      resolveMemoryApplication: vi.fn().mockResolvedValue(memory),
      resolveArtifactApplication: vi.fn().mockResolvedValue(artifacts),
      resolveAnalytics: vi.fn().mockResolvedValue(analytics),
      resolveMonitoringApplication: vi.fn().mockResolvedValue(monitoring),
      resolveExecutionRead: vi.fn().mockResolvedValue(executionRead),
      resolveExecutionApplication: vi.fn().mockResolvedValue(execution),
      resolveProviderApplication: vi.fn().mockResolvedValue(providers),
      resolveMcpApplication: vi.fn().mockResolvedValue(mcp),
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
      execution,
      providers,
      mcp,
    });
    expect(options.resolveExecutionRead).toHaveBeenCalledOnce();
  });

  it("rejects an undefined resolver without consulting deployment kind", async () => {
    await expect(createRequestApplications({
      identity: { tenantId: "tnt_saas" },
      container: { deploymentKind: "saas" },
    } as never, completeResolvers({ resolveSessionApplication: vi.fn().mockResolvedValue(undefined) }) as never)).rejects.toThrow("session application resolver returned no implementation");
  });
});

function completeResolvers(overrides: Record<string, unknown> = {}) {
  return {
    resolveSessionApplication: vi.fn().mockResolvedValue({}), resolveMemoryApplication: vi.fn().mockResolvedValue({}),
    resolveArtifactApplication: vi.fn().mockResolvedValue({}), resolveAnalytics: vi.fn().mockResolvedValue({}),
    resolveMonitoringApplication: vi.fn().mockResolvedValue({}), resolveExecutionRead: vi.fn().mockResolvedValue({}),
    resolveExecutionApplication: vi.fn().mockResolvedValue({}), ...overrides,
    resolveProviderApplication: vi.fn().mockResolvedValue({}), resolveMcpApplication: vi.fn().mockResolvedValue({}),
  };
}
