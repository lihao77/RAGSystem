import { describe, expect, it, vi } from "vitest";
import { AgentConfigSchema, type AgentConfig } from "../src/contracts/agent/agent-config.js";
import { executeRunWithSdk, type SdkRuntimeAdapterDeps } from "../src/services/agent/sdk/runtime-adapter.js";
import type { SessionIdentity } from "../src/contracts/session/session.js";

const runtimeMock = vi.hoisted(() => ({
  createRuntime: vi.fn(),
}));

vi.mock("@ragsystem/agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ragsystem/agent-sdk")>();
  return { ...actual, createRuntime: runtimeMock.createRuntime };
});

const agent = AgentConfigSchema.parse({
  agent_name: "test-agent",
  display_name: "Test Agent",
  llm_tiers: { default: { provider: "provider", model_name: "model" } },
});

const sessionIdentity: SessionIdentity = {
  sessionId: "session-1",
  ownerUserId: null,
  visibility: "private",
  originType: "direct",
  originId: null,
  originChannel: "api",
  workspaceId: null,
  metadata: {},
  permissionMode: null,
};

function input(overrides: Partial<Parameters<typeof executeRunWithSdk>[1]> = {}) {
  return {
    sessionId: "session-1",
    runId: "run-1",
    taskId: "task-1",
    requestId: "request-1",
    rootCallId: "call-1",
    agent,
    provider: {
      key: "provider",
      name: "provider",
      provider_type: "test",
      api_key: "test-key",
      models: ["model"],
      model_map: { chat: "model" },
    },
    modelName: "model",
    task: "run task",
    threadKey: "root",
    sessionIdentity,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function deps(
  finalize: ReturnType<typeof vi.fn>,
  startRun: ReturnType<typeof vi.fn>,
  persist: ReturnType<typeof vi.fn>,
): SdkRuntimeAdapterDeps {
  const session = {
    session_id: "session-1",
    tenant_id: "tenant-1",
    owner_user_id: null,
    visibility: "private",
    origin_type: "direct",
    origin_id: null,
    origin_channel: "api",
    workspace_id: null,
    permission_mode: null,
    metadata: {},
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  } as const;
  return {
    storage: {
      tenantId: "tenant-1",
      conversation: {
        getSession: vi.fn(async () => session),
        getRecentMessages: vi.fn(() => []),
        updateSessionMetadata: vi.fn(async () => ({})),
      },
      providerContinuations: { getProviderContinuation: vi.fn(() => null) },
      createEventPersister: vi.fn(() => ({
        startRun,
        persist,
        finalize,
      })),
    },
    toolsDeps: {
      pendingInteractions: null,
      taskTools: null,
      getAgentDelegation: () => null,
    },
    taskTools: null,
    eventPublisher: {
      publishEnvelope: vi.fn(),
      publishDelegateCall: vi.fn(),
    },
    providers: [{
      key: "provider",
      name: "provider",
      provider_type: "test",
      api_key: "test-key",
      models: ["model"],
      model_map: { chat: "model" },
    }],
    dataRoot: "C:\\tmp",
    permissionPolicy: {
      prepareSession: vi.fn(async () => undefined),
      getEffectivePolicy: vi.fn(() => ({ mode: "default", skip_all_approvals: false })),
    },
    pathAccessPolicyFactory: () => ({ setAllowUnapprovedExternalPaths: vi.fn() }),
    pendingInteractions: { onRootFinalized: vi.fn(async () => undefined) },
    hostToolRegistry: { get: vi.fn(() => []) },
    delegationPending: {},
  } as unknown as SdkRuntimeAdapterDeps;
}

describe("executeRunWithSdk terminal convergence", () => {
  it("startRun 已提交后初始化回调失败也会落 failed 终态消息", async () => {
    runtimeMock.createRuntime.mockReset();
    const startRun = vi.fn(async () => ({ kind: "started", run: {} }));
    const persist = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] }));
    const error = new Error("start callback failed");
    const result = await executeRunWithSdk(
      deps(finalize, startRun, persist),
      input({ onStartDisposition: () => { throw error; } }),
    );

    expect(result.success).toBe(false);
    expect(result.content).toBe("start callback failed");
    expect(finalize).toHaveBeenCalledWith("failed", null, error);
  });

  it("SDK result 成功但事件持久化失败时仍会落 failed 终态消息", async () => {
    runtimeMock.createRuntime.mockReset();
    const startRun = vi.fn(async () => ({ kind: "started", run: {} }));
    const persistError = new Error("event persistence failed");
    const persist = vi.fn(async () => { throw persistError; });
    const finalize = vi.fn(async () => ({ finalMessage: null, records: [], readyResumeInteractionIds: [] }));
    const close = vi.fn();
    runtimeMock.createRuntime.mockReturnValue({
      run: () => ({
        runId: "run-1",
        events: (async function* () {
          yield { type: "assistant_intermediate", message: { content: "partial", contentParts: [] }, round: 0 };
        })(),
        result: Promise.resolve({ content: "done", contentParts: [], finishReason: "stop", metadata: {} }),
      }),
      close,
    });

    const result = await executeRunWithSdk(deps(finalize, startRun, persist), input());

    expect(result.success).toBe(false);
    expect(result.content).toBe("event persistence failed");
    expect(finalize).toHaveBeenCalledWith("failed", null, persistError);
    expect(close).toHaveBeenCalledOnce();
  });
});
