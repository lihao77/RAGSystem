import { describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/integrations/model-adapter.js";
import type { RuntimeClaimResumeResult } from "../../src/contracts/storage/runtime-storage.js";
import { createResumeExecutor } from "../../src/services/agent/execution/resume-executor.js";
import type { AgentRunEngine } from "../../src/services/agent/execution/run-engine.js";
import type { RuntimeExecutionConfigResolver } from "../../src/services/agent/execution/runtime-core-service.js";

type ClaimedResume = Extract<RuntimeClaimResumeResult, { claimed: true }>;

describe("ResumeExecutor", () => {
  it("resolves readiness from the claim descriptor and starts the claimed root run", () => {
    const startResult = {
      started: true,
      session_id: "session-1",
      run_id: "root-run",
      task_id: "resume-task",
      request_id: "request-1",
      kind: "agent_run" as const,
      promise: Promise.resolve({ content: "done", success: true }),
    };
    const startRun = vi.fn(() => startResult);
    const runtimeCore = runtimeCoreStub();
    const executor = createResumeExecutor({
      runEngine: { startRun } as unknown as AgentRunEngine,
      runtimeCore,
    });

    expect(executor.startClaim({ sessionId: "session-1", claim: claim() })).toBe(startResult);
    expect(runtimeCore.resolveExecutionConfig).toHaveBeenCalledWith({
      agentName: "orchestrator_agent",
      teamName: "default",
    });
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      runId: "root-run",
      rootCallId: "root-call",
      resume: true,
      userId: "user-1",
      requestId: "request-1",
      task: "resume task",
      executionKind: "daemon.cron",
      modelName: "test-model",
    }));
  });

  it("rejects an unready claim before starting the run", () => {
    const startRun = vi.fn();
    const runtimeCore: RuntimeExecutionConfigResolver = {
      getReadiness: vi.fn() as never,
      resolveExecutionConfig: vi.fn(() => ({
        readiness: {
          configuration_ready: false,
          requirements: [{ key: "provider", label: "Provider", satisfied: false }],
        },
        agent: null,
        provider: null,
        modelName: null,
      })) as never,
    };
    const executor = createResumeExecutor({
      runEngine: { startRun } as unknown as AgentRunEngine,
      runtimeCore,
    });

    expect(() => executor.startClaim({ sessionId: "session-1", claim: claim() })).toThrow();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("propagates a synchronous run start failure", () => {
    const executor = createResumeExecutor({
      runEngine: { startRun: () => { throw new Error("start failed"); } } as unknown as AgentRunEngine,
      runtimeCore: runtimeCoreStub(),
    });

    expect(() => executor.startClaim({ sessionId: "session-1", claim: claim() })).toThrow("start failed");
  });
});

function claim(): ClaimedResume {
  return {
    claimed: true,
    claimId: "claim-1",
    batchId: "batch-1",
    rootRunId: "root-run",
    rootCallId: "root-call",
    agentName: "orchestrator_agent",
    task: "resume task",
    requestId: "request-1",
    executionKind: "daemon.cron",
    userId: "user-1",
    sessionIdentity: {
      sessionId: "session-1",
      ownerUserId: "user-1",
      visibility: "private",
      originType: "direct",
      originId: null,
      originChannel: "api",
      workspaceId: null,
      metadata: { team: "default" },
      permissionMode: null,
    },
    resolutions: [{
      interactionId: "interaction-1",
      toolCallId: "tool-1",
      resolution: { kind: "approval", approved: true, message: "ok" },
    }],
  };
}

function runtimeCoreStub(): RuntimeExecutionConfigResolver {
  const agent = {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator",
    custom_params: {},
  } as unknown as AgentConfig;
  const provider = {
    key: "test",
    name: "test",
    provider_type: "openai",
  } as unknown as ModelProviderConfig;
  const readiness = {
    configuration_ready: true,
    requirements: [],
  } as unknown as ReturnType<RuntimeExecutionConfigResolver["getReadiness"]>;
  return {
    getReadiness: vi.fn(() => readiness),
    resolveExecutionConfig: vi.fn(() => ({ readiness, agent, provider, modelName: "test-model" })),
  };
}
