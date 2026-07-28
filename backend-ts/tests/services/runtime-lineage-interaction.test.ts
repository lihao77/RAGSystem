import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoverableInterrupt } from "@ragsystem/agent-sdk";

import type { AgentConfig } from "../../src/contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/integrations/model-adapter.js";
import type { AgentRunEngine } from "../../src/services/agent/execution/run-engine.js";
import { AgentDelegationService } from "../../src/services/agent/delegation/index.js";
import { createConversationStore, type ConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { LocalAgentDelegationStoreAdapter } from "../../src/adapters/local/local-agent-delegation-store-adapter.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { toolContext } from "../helpers/tool-context.js";
import { SqliteRuntimeStorage } from "../../src/adapters/local/sqlite-runtime-storage.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { RuntimeInteractionCoordinator } from "../../src/services/runtime/pending-interaction-service.js";
import { AsyncKernelEventPersister } from "../../src/services/agent/sdk/async-event-persister.js";

const stores = new Set<ConversationStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

const provider: ModelProviderConfig = {
  name: "test",
  key: "test",
  provider_type: "deepseek",
  api_key: "test",
  models: ["test-model"],
  model_map: { chat: "test-model" },
};

function agent(name: string, enabledAgents: string[] = []): AgentConfig {
  return {
    agent_name: name,
    display_name: name,
    description: null,
    enabled: true,
    default_entry: false,
    llm_tiers: { default: { provider: "test", provider_type: "deepseek", model_name: "test-model", extra_params: {} } },
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [] },
    mcp: { enabled_servers: [] },
    memory: { auto_inject: false, allowed_scopes: [], write_scopes: [], archive_scopes: [] },
    goals: { enabled: false },
    tasks: { background: false },
    delegation: { enabled_agents: enabledAgents },
    knowledge_base: { enabled: false, default_collection: "documents", default_search_mode: "hybrid", default_top_k: 5, default_rerank: false, default_reranker_key: null },
    custom_params: {},
  };
}

function runtimeCore(target: AgentConfig) {
  const readiness = { configuration_ready: true, requirements: [] };
  return {
    getReadiness: () => readiness,
    resolveExecutionConfig: () => ({ readiness, agent: target, provider, modelName: "test-model" }),
  } as never;
}

function createStore(): ConversationStore {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  stores.add(store);
  return store;
}

describe("runtime execution lineage", () => {
  it("propagates the outer root through a grandchild and rethrows RecoverableInterrupt", async () => {
    const store = createStore();
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "session-1", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    store.createRun({ runId: "root-run", sessionId: "session-1", status: "running", agentName: "root" });
    store.createRun({ runId: "child-run", sessionId: "session-1", status: "running", agentName: "child", parentRunId: "root-run" });
    const emitted: Array<Record<string, any>> = [];
    const delegation = new AgentDelegationService(new LocalAgentDelegationStoreAdapter(store), runtimeCore(agent("worker")), {
      publish: vi.fn((_sessionId, event) => { emitted.push(event as Record<string, any>); return Promise.resolve({} as never); }),
    } as never);
    const seen: Array<Record<string, unknown>> = [];
    const interruptingEngine = {
      async executeRun(input: Record<string, unknown>) {
        seen.push(input);
        throw new RecoverableInterrupt({
          sessionId: String(input.sessionId),
          runId: String(input.runId),
          rootRunId: String(input.rootRunId),
          parentRunId: String(input.parentRunId),
          parentCallId: String(input.rootCallId),
          toolCallId: "approval-call",
          kind: "approval",
        });
      },
    } as unknown as AgentRunEngine;
    delegation.setRunEngine(() => interruptingEngine);

    const grandchildContext = Object.assign(toolContext({
      sessionId: "session-1",
      runId: "child-run",
      rootRunId: "root-run",
      parentCallId: "A0",
      rootTask: "root task",
      currentAgentName: "child",
    }), { rootCallId: "A0", currentCallId: "A1" });
    await expect(delegation.callAgent({
      agent: agent("child", ["worker"]),
      teamName: null,
      input: { agentName: "worker", task: "grandchild task", callId: "A2" },
    }, grandchildContext)).rejects.toBeInstanceOf(RecoverableInterrupt);

    expect(seen[0]).toMatchObject({
      parentRunId: "child-run",
      rootRunId: "root-run",
      rootCallId: emitted[0]?.call_id,
      parentCallId: "A2",
      interactionRootCallId: "A0",
    });
    expect(emitted[0]?.payload?.lineage?.parent_call_id).toBe("A1");
  });

  it("propagates the same root and immediate parent call through send_message", async () => {
    const store = createStore();
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "session-1", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    store.createRun({ runId: "root-run", sessionId: "session-1", status: "running", agentName: "root" });
    store.createRun({ runId: "child-run", sessionId: "session-1", status: "running", agentName: "child", parentRunId: "root-run" });
    store.createChildAgent({
      sessionId: "session-1",
      childAgentId: "worker-instance",
      agentName: "worker",
      threadKey: "child:worker-instance",
      parentRunId: "root-run",
      parentCallId: "A1",
      createdByRunId: "root-run",
      createdByCallId: "A1",
    });
    const emitted: Array<Record<string, any>> = [];
    const delegation = new AgentDelegationService(new LocalAgentDelegationStoreAdapter(store), runtimeCore(agent("worker")), {
      publish: vi.fn((_sessionId, event) => { emitted.push(event as Record<string, any>); return Promise.resolve({} as never); }),
    } as never);
    const seen: Array<Record<string, unknown>> = [];
    delegation.setRunEngine(() => ({
      async executeRun(input: Record<string, unknown>) {
        seen.push(input);
        return { content: "ok", success: true };
      },
    } as unknown as AgentRunEngine));

    const childContext = Object.assign(toolContext({
      sessionId: "session-1",
      runId: "child-run",
      rootRunId: "root-run",
      parentCallId: "A0",
      currentAgentName: "child",
    }), { rootCallId: "A0", currentCallId: "A1" });
    await delegation.sendMessage({
      agent: agent("child"),
      teamName: null,
      input: { childAgentId: "worker-instance", message: "grandchild task", callId: "A2" },
    }, childContext);

    expect(seen[0]).toMatchObject({
      rootRunId: "root-run",
      rootCallId: emitted[0]?.call_id,
      parentRunId: "child-run",
      parentCallId: "A2",
      interactionRootCallId: "A0",
    });
    expect(emitted[0]?.payload?.lineage?.parent_call_id).toBe("A1");
  });

  it("keeps a grandchild interaction under the root claim while child suspension stays isolated", async () => {
    const store = createStore();
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "session-1", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    store.createRun({ runId: "root-run", sessionId: "session-1", status: "running", agentName: "root" });
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const publisher = new DurableClientEventPublisher(storage, { dispatchRows: async () => [] });
    const coordinator = new RuntimeInteractionCoordinator(storage, publisher);
    const childPersister = new AsyncKernelEventPersister(storage, publisher, {
      tenantId: LOCAL_TENANT_ID,
      sessionId: "session-1",
      sessionIdentity: {
        sessionId: "session-1",
        ownerUserId: "usr_system",
        visibility: "tenant",
        originType: "direct",
        originId: null,
        originChannel: "api",
        workspaceId: null,
      },
      runId: "grandchild-run",
      rootRunId: "root-run",
      parentRunId: "child-run",
      parentCallId: "child-call",
      rootCallId: "root-call",
      childAgentId: "grandchild-agent",
      threadKey: "child:grandchild-agent",
      agentName: "grandchild",
      agentDisplayName: "grandchild",
    });
    store.createRun({ runId: "child-run", sessionId: "session-1", status: "running", agentName: "child", parentRunId: "root-run" });
    await childPersister.startRun();

    let interactionId = "";
    const waiting = coordinator.waitForApproval({
      sessionId: "session-1",
      runId: "grandchild-run",
      rootRunId: "root-run",
      parentRunId: "child-run",
      parentCallId: "child-call",
      rootCallId: "root-call",
      toolCallId: "grandchild-tool",
      deadlineMs: 0,
      task: "approve",
      toolName: "execute_bash",
      onInteractionRequired: (notice) => { interactionId = notice.interactionId; },
    });
    await expect(waiting).rejects.toBeInstanceOf(RecoverableInterrupt);
    expect(store.getPendingInteraction("session-1", interactionId)?.root_run_id).toBe("root-run");
    expect(store.getPendingInteraction("session-1", interactionId)?.request_payload).toMatchObject({ rootCallId: "root-call" });

    await childPersister.finalize("suspended", null);
    expect(store.getRun("session-1", "grandchild-run")?.status).toBe("suspended");
    expect(store.getPendingInteraction("session-1", interactionId)?.status).toBe("waiting");

    const rootFinalized = await storage.operations.finalizeRun({
      runId: "root-run",
      sessionId: "session-1",
      status: "suspended",
      interactionRootRunId: "root-run",
    });
    expect(rootFinalized.readyResumeInteractionIds).toEqual([]);
    expect(store.getPendingInteraction("session-1", interactionId)?.status).toBe("suspended");

    const startClaim = vi.fn(() => ({ promise: Promise.resolve({ content: "resumed", success: true }) }));
    coordinator.bindResumeStarter({ startClaim });
    await expect(coordinator.respondApprovalAsync("session-1", interactionId, { approved: true, message: "ok" }))
      .resolves.toMatchObject({ resolved: true, needsResume: true, rootRunId: "root-run" });
    expect(startClaim).toHaveBeenCalledOnce();
    expect(store.getRun("session-1", "root-run")?.status).toBe("running");
    expect(store.getRun("session-1", "grandchild-run")?.status).toBe("suspended");
  });
});
