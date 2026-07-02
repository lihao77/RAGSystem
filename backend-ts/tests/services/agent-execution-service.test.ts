import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import {
  createAgentExecutionService,
  type AgentExecutionLogger,
} from "../../src/services/agent/execution/index.js";
import { AgentSessionApplication } from "../../src/services/sessions/index.js";
import os from "node:os";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { SqliteRuntimeStore } from "@ragsystem/agent-sdk";
import { mockLlm } from "../helpers/llm-fetch-mock.js";
import { makeTempDb } from "../helpers/temp-db.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { HostToolRegistry } from "../../src/services/runtime/host-tool-registry.js";
import { DelegationPendingService } from "../../src/services/runtime/delegation-pending-service.js";
import { PermissionPolicyService } from "../../src/services/runtime/permission-policy-service.js";
import { PendingInteractionService } from "../../src/services/runtime/pending-interaction-service.js";
import type { RuntimeExecutionConfigResolver } from "../../src/services/agent/execution/runtime-core-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type RuntimeMode = "ok" | "abort" | "fail";

interface ServiceHarness {
  service: AgentExecutionService;
  store: ConversationStore;
  errors: Array<Record<string, unknown>>;
}

function minimalAgent(agentName: string): AgentConfig {
  return {
    agent_name: agentName,
    display_name: agentName,
    description: null,
    enabled: true,
    default_entry: false,
    llm_tiers: {
      default: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        extra_params: {},
      },
    },
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: { auto_inject: false, allowed_scopes: [], write_scopes: [], archive_scopes: [] },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: { behavior: { system_prompt: `${agentName} system prompt` } },
  };
}

function runtimeCoreStub(agent: AgentConfig, ready: boolean, provider: ModelProviderConfig): RuntimeExecutionConfigResolver {
  const readiness = {
    kind: "runtime_core",
    status: ready ? "ready" : "not_ready",
    configuration_ready: ready,
    execution_runtime_migrated: ready,
    can_execute: ready,
    agent: {
      agent_name: agent.agent_name,
      display_name: agent.display_name,
      enabled: true,
      default_entry: false,
      source: "agent_config",
    },
    llm: {
      provider: "my",
      provider_type: "deepseek",
      model_name: "deepseek-chat",
      source: "agent_config.default",
    },
    provider: {
      configured: ready,
      provider_key: provider.key ?? null,
      provider_name: provider.name,
      provider_type: provider.provider_type,
      model_available: ready,
      api_key_configured: ready,
    },
    requirements: ready
      ? []
      : [{ category: "agent", satisfied: false, message: "runtime core not ready" }],
    boundary: "test runtime",
  };
  return {
    getReadiness() {
      return readiness;
    },
    resolveExecutionConfig() {
      return {
        readiness,
        agent: ready ? agent : undefined,
        provider: ready ? provider : undefined,
        modelName: ready ? "deepseek-chat" : undefined,
      };
    },
  } as RuntimeExecutionConfigResolver;
}

function buildHarness(opts: { mode?: RuntimeMode; ready?: boolean; logger?: boolean } = {}): ServiceHarness {
  const mode = opts.mode ?? "ok";
  const ready = opts.ready ?? true;
  const dbPath = makeTempDb();
  const store = createConversationStore({ dbPath });
  const sdkStore = new SqliteRuntimeStore({ dbPath });
  const sessions = new AgentSessionApplication(store);
  const realtimeEvents = new RealtimeEventHub();
  const dispatcher = new OutboxDispatcher(store, realtimeEvents);
  const clientEvents = new DurableClientEventPublisher(store, dispatcher);
  const hostToolRegistry = new HostToolRegistry();
  const delegationPending = new DelegationPendingService();
  const permissionPolicy = new PermissionPolicyService();
  const pendingInteractions = new PendingInteractionService(clientEvents);
  const agent = minimalAgent("orchestrator_agent");
  const provider: ModelProviderConfig = {
    name: "my",
    key: "my_deepseek",
    provider_type: "deepseek",
    api_key: "sk-test",
    models: ["deepseek-chat"],
    model_map: { chat: "deepseek-chat" },
  };
  const errors: Array<Record<string, unknown>> = [];
  const logger: AgentExecutionLogger | null = opts.logger
    ? { error: (bindings, message) => errors.push({ ...bindings, message }) }
    : null;
  mockLlm({ mode, contents: ["the answer"] });
  const service = createAgentExecutionService({
    sessions,
    conversationStore: store,
    sdkStore,
    runtimeCore: runtimeCoreStub(agent, ready, provider),
    dataRoot: os.tmpdir(),
   outboxDispatcher: dispatcher,
   providersProvider: () => [provider],
   clientEvents,
   hostToolRegistry,
   delegationPending,
   permissionPolicy,
   pendingInteractions,
    logger: logger ?? null,
  });
  return { service, store, sdkStore, errors };
}

const WAIT = { timeout: 4000, interval: 20 };

describe("AgentExecutionService (baseline regression)", () => {
  it("runs a stream to completion and records the assistant message", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const started = await service.startStream({ task: "hello world", attachments: [] }, "req-1");
    expect(started.started).toBe(true);
    expect(started.run_id).toBeTruthy();
    const sessionId = started.session_id;
    await vi.waitFor(
      () => {
        expect(service.getSessionTaskStatus(sessionId).task_info?.status).toBe("completed");
      },
      WAIT,
    );
    const messages = store.listMessages(sessionId, 50, 0).items;
    expect(messages.map((m) => [m.role, m.content])).toContainEqual(["assistant", "the answer"]);
    store.close();
  });

  it("marks a stopped session as interrupted", async () => {
    const { service, store } = buildHarness({ mode: "abort" });
    const started = await service.startStream({ task: "long work", attachments: [] }, "req-1");
    const stopped = await service.stopSession(started.session_id);
    expect(stopped).toBe(true);
    await vi.waitFor(
      () => {
        expect(service.getSessionTaskStatus(started.session_id).task_info?.status).toBe("interrupted");
      },
      WAIT,
    );
    store.close();
  });

  it("records a failed run and logs the error when the runtime throws", async () => {
    const { service, store, errors } = buildHarness({ mode: "fail", logger: true });
    const started = await service.startStream({ task: "boom", attachments: [] }, "req-1");
    await vi.waitFor(
      () => {
        expect(service.getSessionTaskStatus(started.session_id).task_info?.status).toBe("failed");
      },
      WAIT,
    );
    expect(errors.some((entry) => String(entry.message).includes("agent runtime execution failed"))).toBe(true);
    store.close();
  });

  it("rejects startStream when runtime core is not ready", async () => {
    const { service, store } = buildHarness({ ready: false });
    const started = await service.startStream({ task: "x", attachments: [] }, "req-1");
    expect(started.started).toBe(false);
    expect(started.error).toBeTruthy();
    store.close();
  });

  it("rejects an empty task with no attachments", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const started = await service.startStream({ task: "   ", attachments: [] }, "req-1");
    expect(started.started).toBe(false);
    expect(String(started.error)).toMatch(/empty/i);
    store.close();
  });

  it("executes synchronously and returns the final answer", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const result = await service.executeSynchronously({ task: "sync task", attachments: [] }, "req-2");
    expect(result.success).toBe(true);
    expect(result.answer).toBe("the answer");
    store.close();
  });

  it("handles the /help slash command via the slash handler", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const result = await service.startStream({ task: "/help", attachments: [] }, "req-1");
    expect(result.started).toBe(true);
    expect(result.kind).toBe("command");
    const messages = store.listMessages(result.session_id, 50, 0).items;
    expect(messages.some((m) => m.role === "system" && String(m.content).includes("可用命令"))).toBe(true);
    store.close();
  });
});
