import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent/agent-config.js";
import type { AgentExecuteResult } from "../../src/contracts/execution/execution.js";
import type { ModelProviderConfig } from "../../src/contracts/integrations/model-adapter.js";
import {
  createAgentExecutionService,
  type AgentExecutionService,
  type AgentExecutionLogger,
} from "../../src/services/agent/execution/index.js";
import type { ConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { AgentSessionApplication } from "../../src/services/sessions/index.js";
import { LocalAgentSessionRepository } from "../../src/adapters/local/local-agent-session-repository.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { mockLlm } from "../helpers/llm-fetch-mock.js";
import { makeTempDb } from "../helpers/temp-db.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../src/services/identity/index.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { SqliteRuntimeStorage } from "../../src/adapters/local/sqlite-runtime-storage.js";
import { LocalOutboxStoreAdapter } from "../../src/adapters/local/local-outbox-store-adapter.js";
import { HostToolRegistry } from "../../src/services/runtime/host-tool-registry.js";
import { DelegationPendingService } from "../../src/services/runtime/delegation-pending-service.js";
import { PermissionPolicyService } from "../../src/services/runtime/permission-policy-service.js";
import { PathApprovalService } from "../../src/adapters/local/path-approval-service.js";
import { RuntimeInteractionCoordinator } from "../../src/services/runtime/pending-interaction-service.js";
import type { RuntimeExecutionConfigResolver } from "../../src/services/agent/execution/runtime-core-service.js";
import { createLocalExecutionStorage } from "../../src/adapters/local/local-execution-storage.js";
import { AgentMetricsCollector } from "../../src/services/agent/metrics/metrics-collector.js";
import type { AgentMetricsStorePort } from "../../src/contracts/runtime/core-runtime-ports.js";
import type { LlmMock } from "../helpers/llm-fetch-mock.js";
import { BackgroundTaskService } from "../../src/services/runtime/background-task-service.js";
import { SessionNotificationQueue } from "../../src/services/runtime/session-notification-queue.js";
import { LocalGoalStore } from "../../src/adapters/local/local-goal-store.js";
import type { GoalStore } from "../../src/contracts/runtime/goals.js";
import { TaskToolService } from "../../src/tools/TaskTools/TaskExecution.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type RuntimeMode = "ok" | "abort" | "fail";

interface ServiceHarness {
  service: AgentExecutionService;
  store: ConversationStore;
  errors: Array<Record<string, unknown>>;
  llm: LlmMock;
  backgroundTasks: BackgroundTaskService | null;
  goalStore: GoalStore | null;
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
    skills: { enabled_skills: [] },
    mcp: { enabled_servers: [] },
    memory: { auto_inject: false, allowed_scopes: [], write_scopes: [], archive_scopes: [] },
    goals: { enabled: false },
    tasks: { background: false },
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

function buildHarness(opts: {
  mode?: RuntimeMode;
  ready?: boolean;
  logger?: boolean;
  startFailure?: Error;
  metricsCollector?: AgentMetricsCollector | null;
  goalMode?: boolean;
} = {}): ServiceHarness {
  const mode = opts.mode ?? "ok";
  const ready = opts.ready ?? true;
  const dbPath = makeTempDb();
  const store = createConversationStore({ dbPath, dataRoot: path.dirname(dbPath) });
  const sessions = new AgentSessionApplication(new LocalAgentSessionRepository(store));
  const realtimeEvents = new RealtimeEventHub();
  const dispatcher = new OutboxDispatcher(new LocalOutboxStoreAdapter(store), realtimeEvents);
  const runtimeStorage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
  const executionRuntimeStorage = opts.startFailure
    ? {
        tenantId: runtimeStorage.tenantId,
        operations: {
          ...runtimeStorage.operations,
          startRun: async () => { throw opts.startFailure; },
          startOrAppendRoot: async () => { throw opts.startFailure; },
        },
      }
    : runtimeStorage;
  const executionClientEvents = new DurableClientEventPublisher(runtimeStorage, {
    dispatchRows: async () => [],
  });
  const clientEvents = executionClientEvents;
  const hostToolRegistry = new HostToolRegistry();
  const delegationPending = new DelegationPendingService();
  const permissionPolicy = new PermissionPolicyService(store);
  const pendingInteractions = new RuntimeInteractionCoordinator(runtimeStorage, executionClientEvents);
  const agent = minimalAgent("orchestrator_agent");
  if (opts.goalMode) {
    agent.goals = { enabled: true };
    agent.tasks = { background: true };
  }
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
  const llm = mockLlm({ mode, contents: ["the answer"] });
  const notificationQueue = opts.goalMode ? new SessionNotificationQueue() : null;
  const backgroundTasks = notificationQueue ? new BackgroundTaskService({ notificationQueue }) : null;
  const goalStore = opts.goalMode ? new LocalGoalStore(LOCAL_TENANT_ID, store) : null;
  const taskTools = backgroundTasks && notificationQueue && goalStore
    ? new TaskToolService(backgroundTasks, notificationQueue, goalStore)
    : null;
  const service = createAgentExecutionService({
    tenantId: LOCAL_TENANT_ID,
    sessions,
    executionStorage: createLocalExecutionStorage({
      tenantId: LOCAL_TENANT_ID,
      conversation: store,
      runtimeStorage: executionRuntimeStorage,
      clientEvents: executionClientEvents,
    }),
    runtimeCore: runtimeCoreStub(agent, ready, provider),
    dataRoot: os.tmpdir(),
    getMemoryConfig: () => ({ index_max_lines: 200, index_max_chars: 25600 }),
   outboxDispatcher: dispatcher,
   providersProvider: () => [provider],
    clientEvents,
   hostToolRegistry,
   delegationPending,
    permissionPolicy,
    pathAccessPolicyFactory: () => new PathApprovalService(),
   pendingInteractions,
    runtimeStorage: executionRuntimeStorage,
    logger: logger ?? null,
    metricsCollector: opts.metricsCollector ?? null,
    taskTools,
    goalStore,
    backgroundTasks,
    notificationQueue,
  });
  backgroundTasks?.setOnTaskCompleted((sessionId) => service.triggerBgNotificationRun(sessionId));
  return { service, store, errors, llm, backgroundTasks, goalStore };
}

const WAIT = { timeout: 4000, interval: 20 };

describe("AgentExecutionService (baseline regression)", () => {
  it("runs a stream to completion and records the assistant message", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const started = await service.startStream({ task: "hello world", attachments: [], userId: LOCAL_USER_ID }, "req-1");
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
    expect(messages.filter((message) => message.role === "user" && message.content === "hello world")).toHaveLength(1);
    expect(messages.map((m) => [m.role, m.content])).toContainEqual(["assistant", "the answer"]);
    store.close();
  });

  it("marks a stopped session as interrupted", async () => {
    const { service, store } = buildHarness({ mode: "abort" });
    const started = await service.startStream({ task: "long work", attachments: [], userId: LOCAL_USER_ID }, "req-1");
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

  it("makes a concurrent followup durable before the active run reaches a boundary", async () => {
    const { service, store } = buildHarness({ mode: "abort" });
    const first = await service.startStream({ task: "first", attachments: [], userId: LOCAL_USER_ID }, "req-first");
    const second = await service.startStream({ session_id: first.session_id, task: "second", attachments: [], userId: LOCAL_USER_ID }, "req-second");

    expect(second).toMatchObject({ started: true, session_id: first.session_id, run_id: first.run_id, request_id: "req-second" });
    expect(store.listRuns(first.session_id, 100).items).toHaveLength(1);
    expect(store.listMessages(first.session_id, 100, 0).items).toContainEqual(expect.objectContaining({
      role: "user",
      content: "second",
      metadata: expect.objectContaining({ execution_kind: "session_followup" }),
    }));
    await service.stopSession(first.session_id);
    await vi.waitFor(() => {
      expect(store.listRuns(first.session_id, 100).items).toHaveLength(2);
      expect(store.listMessages(first.session_id, 100, 0).items).toContainEqual(expect.objectContaining({
        role: "user",
        content: "second",
        metadata: expect.objectContaining({
          execution_kind: "session_followup",
          followup_pending: false,
        }),
      }));
    }, WAIT);
    expect(store.listMessages(first.session_id, 100, 0).items.filter((message) => message.content === "second")).toHaveLength(1);
    await service.stopSession(first.session_id);
    store.close();
  });

  it("claims the new session handle after storage starts a root while the prior run is finishing", async () => {
    let resolveFirstMetric!: () => void;
    let resolveMetricGate!: () => void;
    const firstMetricReached = new Promise<void>((resolve) => {
      resolveFirstMetric = resolve;
    });
    const firstMetricGate = new Promise<void>((resolve) => {
      resolveMetricGate = resolve;
    });
    let metricCount = 0;
    const metricsCollector = new AgentMetricsCollector({
      insertMetric: async () => {
        metricCount += 1;
        if (metricCount === 1) {
          resolveFirstMetric();
          await firstMetricGate;
        }
      },
      aggregateMetrics: async () => [],
      resetMetrics: async () => ({ deleted: 0 }),
    } satisfies AgentMetricsStorePort);
    const { service, store, llm } = buildHarness({ metricsCollector });

    const first = await service.startStream({ task: "first", attachments: [], userId: LOCAL_USER_ID }, "req-first");
    await firstMetricReached;
    expect(store.getRun(first.session_id, first.run_id!)?.status).toBe("completed");
    expect(service.getSessionTaskStatus(first.session_id)).toMatchObject({
      has_running_task: true,
      task_info: { run_id: first.run_id, status: "running" },
    });
    llm.hold();

    const second = await service.startStream({
      session_id: first.session_id,
      task: "second",
      attachments: [],
      userId: LOCAL_USER_ID,
    }, "req-second");
    await vi.waitFor(() => {
      expect(llm.requests).toHaveLength(2);
      expect(service.getSessionTaskStatus(first.session_id).task_info).toMatchObject({
        run_id: second.run_id,
        status: "running",
      });
    }, WAIT);

    resolveMetricGate();
    await vi.waitFor(() => {
      expect(service.getTaskStatus(first.task_id!).task_info?.status).toBe("completed");
    }, WAIT);
    expect(service.getSessionTaskStatus(first.session_id)).toMatchObject({
      has_running_task: true,
      task_info: { run_id: second.run_id, status: "running" },
    });

    llm.release();
    await vi.waitFor(() => {
      expect(service.getSessionTaskStatus(first.session_id).has_running_task).toBe(false);
    }, WAIT);
    store.close();
  });

  it("records a failed run and logs the error when the runtime throws", async () => {
    const { service, store, errors } = buildHarness({ mode: "fail", logger: true });
    const started = await service.startStream({ task: "boom", attachments: [], userId: LOCAL_USER_ID }, "req-1");
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
    const started = await service.startStream({ task: "x", attachments: [], userId: LOCAL_USER_ID }, "req-1");
    expect(started.started).toBe(false);
    expect(started.error).toBeTruthy();
    store.close();
  });

  it("does not report started before the durable start transaction commits", async () => {
    const { service, store } = buildHarness({ startFailure: new Error("durable start rejected") });
    const result = await service.startStream(
      { task: "must persist first", attachments: [], userId: LOCAL_USER_ID },
      "req-durable-failure",
    );

    expect(result).toMatchObject({ started: false, error: "durable start rejected" });
    expect(store.getSession(result.session_id)).toBeNull();
    expect(store.listMessages(result.session_id, 100, 0).items).toEqual([]);
    expect(store.listRuns(result.session_id, 100).items).toEqual([]);
    expect(store.listRunSteps({ sessionId: result.session_id, limit: 100 })).toEqual([]);
    expect(store.listOutbox({ sessionId: result.session_id }).items).toEqual([]);
    store.close();
  });


  it("rejects an empty task with no attachments", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const started = await service.startStream({ task: "   ", attachments: [], userId: LOCAL_USER_ID }, "req-1");
    expect(started.started).toBe(false);
    expect(String(started.error)).toMatch(/empty/i);
    store.close();
  });

  it("executes synchronously and returns the final answer", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const result = await service.executeSynchronously({ task: "sync task", userId: LOCAL_USER_ID }, "req-2");
    expect(result.success).toBe(true);
    expect(result.answer).toBe("the answer");
    store.close();
  });

  it("waits for the durable followup completion for a synchronous bot message", async () => {
    const { service, store, llm } = buildHarness({ mode: "ok" });
    llm.hold();
    const first = await service.startStream({ task: "first", attachments: [], userId: LOCAL_USER_ID }, "req-first");
    const completed = service.executeSynchronously({
      session_id: first.session_id,
      task: "bot followup",
      executionKind: "daemon.feishu.incoming",
      userId: LOCAL_USER_ID,
    }, "req-bot-followup");

    await vi.waitFor(() => {
      expect(store.listMessages(first.session_id, 100, 0).items).toContainEqual(expect.objectContaining({
        role: "user",
        content: "bot followup",
        metadata: expect.objectContaining({ execution_kind: "session_followup", followup_pending: true }),
      }));
    }, WAIT);
    llm.release();
    const result = await completed;
    expect(result).toMatchObject({
      success: true,
      answer: "the answer",
      session_id: first.session_id,
      error: null,
    });
    expect(store.listMessages(first.session_id, 100, 0).items.filter((message) => message.content === "bot followup")).toHaveLength(1);
    store.close();
  });

  it("keeps a joined synchronous followup as a successful queue acknowledgement", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "joined-followup-session", ownerUserId: LOCAL_USER_ID, visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    store.createRun({
      runId: "joined-active-run",
      sessionId: "joined-followup-session",
      status: "running",
      agentName: "orchestrator_agent",
    });
    const runEngine = (service as AgentExecutionService & {
      runEngine: {
        buildSynchronousResult(input: Record<string, unknown>): Promise<AgentExecuteResult>;
      };
    }).runEngine;

    await expect(runEngine.buildSynchronousResult({
      sessionId: "joined-followup-session",
      runId: "joined-active-run",
      taskId: "joined-task",
      agentName: "orchestrator_agent",
      outcome: {
        content: "消息已进入后续队列",
        success: true,
        followupJoined: true,
      },
    })).resolves.toMatchObject({
      success: true,
      answer: "消息已进入后续队列",
      error: null,
      metadata: { followup_joined: true },
    });
    store.close();
  });

  it("returns one continuation final while joined synchronous followups receive an acknowledgement", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "multi-followup-session", ownerUserId: LOCAL_USER_ID, visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    store.createRun({
      runId: "continuation-run",
      sessionId: "multi-followup-session",
      status: "running",
      agentName: "orchestrator_agent",
    });
    const final = store.addMessage({
      sessionId: "multi-followup-session",
      role: "assistant",
      content: "continuation answer",
      metadata: { run_id: "continuation-run" },
    });
    store.updateRunStatus("continuation-run", "multi-followup-session", "completed", final.id);
    for (const [messageId, trigger] of [["followup-trigger", true], ["followup-joined", false]] as const) {
      store.addMessage({
        messageId,
        sessionId: "multi-followup-session",
        role: "user",
        content: messageId,
        metadata: {
          execution_kind: "session_followup",
          followup_pending: false,
          consumed_by_run_id: "continuation-run",
          followup_continuation_trigger: trigger,
        },
      });
    }
    const runEngine = (service as unknown as {
      runEngine: {
        waitForFollowupCompletion(
          sessionId: string,
          messageId: string,
          initiallyActiveRunId: string,
          continuation: Record<string, unknown>,
        ): Promise<Record<string, unknown>>;
      };
    }).runEngine;

    await expect(runEngine.waitForFollowupCompletion(
      "multi-followup-session",
      "followup-trigger",
      "old-run",
      {},
    )).resolves.toMatchObject({
      content: "continuation answer",
      success: true,
      runId: "continuation-run",
    });
    await expect(runEngine.waitForFollowupCompletion(
      "multi-followup-session",
      "followup-joined",
      "old-run",
      {},
    )).resolves.toMatchObject({
      content: "消息已进入后续队列",
      success: true,
      runId: "continuation-run",
      followupJoined: true,
    });
    store.close();
  });

  it("does not wait forever when a pending synchronous followup reaches a suspended root", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "suspended-followup-session", ownerUserId: LOCAL_USER_ID, visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    store.createRun({
      runId: "suspended-root",
      sessionId: "suspended-followup-session",
      status: "suspended",
      agentName: "orchestrator_agent",
    });
    store.addMessage({
      messageId: "suspended-followup",
      sessionId: "suspended-followup-session",
      role: "user",
      content: "wait for resume",
      metadata: { execution_kind: "session_followup", followup_pending: true },
    });
    const runEngine = (service as unknown as {
      runEngine: {
        waitForFollowupCompletion(
          sessionId: string,
          messageId: string,
          initiallyActiveRunId: string,
          continuation: Record<string, unknown>,
        ): Promise<Record<string, unknown>>;
      };
    }).runEngine;

    await expect(runEngine.waitForFollowupCompletion(
      "suspended-followup-session",
      "suspended-followup",
      "suspended-root",
      {},
    )).resolves.toMatchObject({
      success: true,
      runId: "suspended-root",
      followupJoined: true,
      content: expect.stringContaining("等待交互"),
    });
    store.close();
  });

  it("routes stream and synchronous starts through the same run engine", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const runEngine = (service as ReturnType<typeof createAgentExecutionService>).runEngine;
    const startRun = vi.spyOn(runEngine, "startRun");

    const streamed = await service.startStream({
      session_id: "unified-stream-session",
      task: "stream task",
      attachments: [],
      userId: LOCAL_USER_ID,
    }, "req-stream");
    const synchronous = await service.executeSynchronously({
      session_id: "unified-sync-session",
      task: "sync task",
      executionKind: "daemon.feishu",
      userId: LOCAL_USER_ID,
    }, "req-sync");

    expect(streamed.started).toBe(true);
    expect(synchronous.success).toBe(true);
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "unified-stream-session",
      requestId: "req-stream",
      executionKind: "agent_stream",
    });
    expect(startRun.mock.calls[1]?.[0]).toMatchObject({
      sessionId: "unified-sync-session",
      requestId: "req-sync",
      executionKind: "daemon.feishu",
      entrypoint: "execute",
    });

    await vi.waitFor(() => {
      expect(service.getSessionTaskStatus(streamed.session_id).task_info?.status).toBe("completed");
    }, WAIT);
    store.close();
  });

  it("falls back to the direct outcome when the persisted run is unavailable", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const runEngine = (service as AgentExecutionService & {
      runEngine: { buildSynchronousResult(input: Record<string, unknown>): ReturnType<AgentExecutionService["executeSynchronously"]> extends Promise<infer T> ? T : never };
    }).runEngine;
    await expect(runEngine.buildSynchronousResult({
      sessionId: "saas-session",
      runId: "saas-run",
      taskId: "saas-task",
      agentName: "orchestrator_agent",
      outcome: { content: "async answer", success: true },
    })).resolves.toMatchObject({ success: true, answer: "async answer", error: null, run_id: "saas-run" });
    await expect(runEngine.buildSynchronousResult({
      sessionId: "saas-session",
      runId: "failed-run",
      taskId: "failed-task",
      agentName: "orchestrator_agent",
      outcome: { content: "provider rejected request", success: false },
    })).resolves.toMatchObject({ success: false, answer: null, error: "provider rejected request" });
    store.close();
  });

  it("handles the /help slash command via the slash handler", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    const result = await service.startStream({ task: "/help", attachments: [], userId: LOCAL_USER_ID }, "req-1");
    expect(result.started).toBe(true);
    expect(result.kind).toBe("command");
    expect(result.command_result).toMatchObject({ success: true, content: expect.stringContaining("可用命令") });
    const messages = store.listMessages(result.session_id, 50, 0).items;
    expect(messages.some((m) => m.role === "system" && String(m.content).includes("可用命令"))).toBe(true);
    store.close();
  });

  it("handles slash commands through the same entry for synchronous callers", async () => {
    const { service, store, llm } = buildHarness({ mode: "ok" });
    const result = await service.executeSynchronously({
      session_id: "sync-command-session",
      task: "/help",
      userId: LOCAL_USER_ID,
    }, "req-sync-command");

    expect(result).toMatchObject({
      success: true,
      session_id: "sync-command-session",
      run_id: null,
      task_id: null,
    });
    expect(result.answer).toContain("可用命令");
    expect(llm.requests).toHaveLength(0);
    store.close();
  });

  it("rolls back first and resends through the shared slash-aware entry", async () => {
    const { service, store, llm } = buildHarness({ mode: "ok" });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "retry-command-session", ownerUserId: LOCAL_USER_ID, visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    const anchor = store.addMessage({
      sessionId: "retry-command-session",
      role: "user",
      content: "old task",
    });
    store.addMessage({
      sessionId: "retry-command-session",
      role: "assistant",
      content: "old answer",
    });

    const result = await service.startRollbackRetry({
      sessionId: "retry-command-session",
      userId: LOCAL_USER_ID,
      requestId: "req-retry-command",
      afterMessageId: anchor.id,
      modifyUserMessage: "/help",
    });

    expect(result).toMatchObject({ started: true, kind: "command", deleted: 2 });
    expect(store.listMessages("retry-command-session", 20, 0).items.map((message) => [message.role, message.content])).toEqual([
      ["user", "/help"],
      ["system", expect.stringContaining("可用命令")],
    ]);
    expect(llm.requests).toHaveLength(0);
    store.close();
  });

  it("reuses the rollback maintenance reservation for a retried /compact command", async () => {
    const { service, store } = buildHarness({ mode: "ok" });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "retry-compact-session", ownerUserId: LOCAL_USER_ID, visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    const anchor = store.addMessage({
      sessionId: "retry-compact-session",
      role: "user",
      content: "old task",
    });
    store.addMessage({
      sessionId: "retry-compact-session",
      role: "assistant",
      content: "old answer",
    });

    const result = await service.startRollbackRetry({
      sessionId: "retry-compact-session",
      userId: LOCAL_USER_ID,
      requestId: "req-retry-compact",
      afterMessageId: anchor.id,
      modifyUserMessage: "/compact",
    });

    expect(result).toMatchObject({
      started: false,
      kind: "command",
      deleted: 2,
      command_result: {
        success: false,
        content: "压缩服务未装配",
      },
    });
    expect(result.command_result?.content).not.toContain("维护操作");
    expect(store.listMessages("retry-compact-session", 20, 0).items.map((message) => [message.role, message.content])).toEqual([
      ["user", "/compact"],
      ["system", "压缩服务未装配"],
    ]);
    store.close();
  });

  it("starts one continuation run when an active Goal becomes idle", async () => {
    const { service, store, llm, goalStore, backgroundTasks } = buildHarness({ goalMode: true });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "goal-active-session", ownerUserId: LOCAL_USER_ID, visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    const goal = await goalStore!.create("goal-active-session", {
      objective: "Finish the durable Goal",
      successCriteria: ["verified"],
      steps: [{ id: "1", title: "Verify", description: "Run checks", status: "in_progress", evidence: null }],
    });

    await service.startStream({ session_id: "goal-active-session", task: "begin", attachments: [], userId: LOCAL_USER_ID }, "goal-root");
    await vi.waitFor(() => expect(llm.requests.length).toBe(2), { timeout: 4_000, interval: 20 });
    await goalStore!.update("goal-active-session", goal.id, { status: "paused" });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(llm.requests).toHaveLength(2);
    expect(await goalStore!.get("goal-active-session", goal.id)).toMatchObject({
      continuation_count: 1,
      continuation_generation: 1,
      continuation_pending: false,
      status: "paused",
    });
    backgroundTasks?.dispose();
    store.close();
  });

  it("does not continue a paused Goal after the root run ends", async () => {
    const { service, store, llm, goalStore, backgroundTasks } = buildHarness({ goalMode: true });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "goal-paused-session", ownerUserId: LOCAL_USER_ID, visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    const goal = await goalStore!.create("goal-paused-session", {
      objective: "Wait for resume",
      successCriteria: ["resumed"],
    });
    await goalStore!.update("goal-paused-session", goal.id, { status: "paused" });

    await service.startStream({ session_id: "goal-paused-session", task: "one run", attachments: [], userId: LOCAL_USER_ID }, "paused-root");
    await vi.waitFor(() => expect(service.getSessionTaskStatus("goal-paused-session").has_running_task).toBe(false), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(llm.requests).toHaveLength(1);
    expect(await goalStore!.get("goal-paused-session", goal.id)).toMatchObject({ status: "paused", continuation_count: 0 });
    backgroundTasks?.dispose();
    store.close();
  });

  it("deduplicates repeated idle triggers for the same active Goal", async () => {
    const { service, store, llm, goalStore, backgroundTasks } = buildHarness({ goalMode: true });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "goal-dedupe-session", ownerUserId: LOCAL_USER_ID, visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    const goal = await goalStore!.create("goal-dedupe-session", {
      objective: "Run exactly one continuation",
      successCriteria: ["one continuation"],
    });

    await service.startStream({ session_id: "goal-dedupe-session", task: "root", attachments: [], userId: LOCAL_USER_ID }, "dedupe-root");
    await vi.waitFor(() => expect(service.getSessionTaskStatus("goal-dedupe-session").has_running_task).toBe(false), WAIT);
    backgroundTasks!.scheduleAutoTrigger("goal-dedupe-session");
    backgroundTasks!.scheduleAutoTrigger("goal-dedupe-session");
    service.triggerBgNotificationRun("goal-dedupe-session");
    service.triggerBgNotificationRun("goal-dedupe-session");
    await vi.waitFor(() => expect(llm.requests.length).toBe(2), { timeout: 4_000, interval: 20 });
    await goalStore!.update("goal-dedupe-session", goal.id, { status: "paused" });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(llm.requests).toHaveLength(2);
    expect((await goalStore!.get("goal-dedupe-session", goal.id))?.continuation_count).toBe(1);
    backgroundTasks?.dispose();
    store.close();
  });

  it("waits for all session background tasks before continuing the Goal", async () => {
    const { service, store, llm, goalStore, backgroundTasks } = buildHarness({ goalMode: true });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "goal-background-session", ownerUserId: LOCAL_USER_ID, visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    const goal = await goalStore!.create("goal-background-session", {
      objective: "Consume background work before continuing",
      successCriteria: ["background result consumed"],
    });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-background-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    backgroundTasks!.runCallable({
      outputDir,
      sessionId: "goal-background-session",
      run: async () => { await gate; return { success: true }; },
    });

    await service.startStream({ session_id: "goal-background-session", task: "root", attachments: [], userId: LOCAL_USER_ID }, "background-root");
    await vi.waitFor(() => expect(service.getSessionTaskStatus("goal-background-session").has_running_task).toBe(false), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(llm.requests).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(llm.requests.length).toBe(2), { timeout: 4_000, interval: 20 });
    await goalStore!.update("goal-background-session", goal.id, { status: "paused" });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(llm.requests).toHaveLength(2);
    expect(backgroundTasks!.hasRunningTasks("goal-background-session")).toBe(false);

    backgroundTasks?.dispose();
    store.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  });
});
