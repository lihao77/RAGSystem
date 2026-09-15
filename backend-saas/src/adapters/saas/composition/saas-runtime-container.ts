import path from "node:path";

import type { HookRegistry } from "@ragsystem/agent-sdk";
import { RunSandboxManager } from "@ragsystem/sandbox-runtime";
import type { BackendRuntimeContributions } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { EXECUTION_ENVIRONMENT_CAPABILITY, createSaaSExecutionEnvironment } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import { IMAGE_REQUEST_NORMALIZER_CAPABILITY } from "@ragsystem/backend-core/contracts/images/image-request.js";
import { SaaSToolImageSink } from "./tool-image-sink.js";
import { CoreImageRequestNormalizer } from "@ragsystem/backend-core/services/images/image-request-normalizer.js";

import type { RuntimeContainer, SaaSRuntimeContainer } from "@ragsystem/backend-core/contracts/runtime/runtime-container.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { EntityLifecyclePublisher } from "@ragsystem/backend-core/contracts/runtime/entity-lifecycle-events.js";
import { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";
import { ensureDefaultTeam } from "./default-team.js";
import type { AgentExecutionLogger } from "@ragsystem/backend-core/services/agent/execution/index.js";
import { AsyncKernelEventPersister } from "@ragsystem/backend-core/services/agent/sdk/async-event-persister.js";
import { SystemConfigService } from "@ragsystem/backend-core/services/config/system-config-service.js";
import { SessionTitleService } from "@ragsystem/backend-core/services/sessions/session-title-service.js";
import { readSessionRequestOverrides } from "@ragsystem/backend-core/services/agent/execution/session-request-overrides.js";
// system config store is created via conversationRuntime (Postgres sole source of truth)
import { ModelAdapterService } from "@ragsystem/backend-core/services/integrations/model-adapter-service.js";
import { BackgroundTaskService } from "@ragsystem/backend-core/services/runtime/background-task-service.js";
import { createCoreRuntimeContainer } from "@ragsystem/backend-core/services/runtime/core-runtime-container.js";
import { createPendingInteractionBinding } from "@ragsystem/backend-core/services/runtime/pending-interaction-binding.js";
import { DelegationPendingService } from "@ragsystem/backend-core/services/runtime/delegation-pending-service.js";
import { DurableClientEventPublisher } from "@ragsystem/backend-core/services/runtime/event-outbox/client-event-publisher.js";
import { HostToolRegistry } from "@ragsystem/backend-core/services/runtime/host-tool-registry.js";
import { PathApprovalService } from "@ragsystem/backend-core/services/runtime/path-approval-service.js";
import { TaskToolService } from "@ragsystem/backend-core/tools/TaskTools/TaskExecution.js";
import { SaaSSessionApplication } from "../application/session/saas-session-application.js";
import { toModelProviderConfig } from "../application/provider/provider-config-mapping.js";
import { SaaSAgentMetricsStore } from "../postgres/saas-agent-metrics-store.js";
import { SaaSPermissionPolicyStore } from "../postgres/saas-permission-policy-store.js";
import { createPostgresExecutionStorage } from "../postgres/postgres-execution-storage.js";
import type { SaaSConversationRuntimeHandle } from "./saas-conversation-runtime.js";
import type { SandboxDriver } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { SaaSSandboxFileBridge } from "../sandbox/sandbox-file-bridge.js";
export interface SaaSRuntimeContainerOptions {
  tenantId: TenantId;
  dataRoot: string;
  conversationRuntime: SaaSConversationRuntimeHandle;
  logger?: AgentExecutionLogger;
  hooks?: (registry: HookRegistry) => void;
  plugins?: BackendRuntimeContributions;
  /** 宿主注入的实体生命周期事件发布端口；注入后领域服务的删除/重命名会广播生命周期事件。 */
  lifecycleEvents?: EntityLifecyclePublisher;
  modelAdapterProvidersConfigPath?: string;
  sandboxDriver: SandboxDriver;
  sandboxLeaseTimeoutSeconds?: number;
}

/** Assemble a tenant runtime without constructing any Local or SQLite adapter. */
export async function createSaaSRuntimeContainer(options: SaaSRuntimeContainerOptions): Promise<SaaSRuntimeContainer> {
  if (!options.sandboxDriver) {
    throw new Error("SaaS runtime container requires a sandbox driver");
  }
  const { tenantId, conversationRuntime } = options;
  const dataRoot = path.resolve(options.dataRoot);
  const runtimeStorage = conversationRuntime.createRuntimeStorage(tenantId);
  const realtimeEvents = conversationRuntime.createRealtimeEventBus(tenantId);
  // Fast-path publisher: claim+deliver newly written rows via the shared process dispatcher.
  // Recovery polling is owned by conversationRuntime.sharedOutboxDispatcher (one per process).
  const outboxDispatcher = conversationRuntime.sharedOutboxDispatcher;
  const clientEvents = new DurableClientEventPublisher(runtimeStorage, {
    dispatchRows: (rows) => outboxDispatcher.dispatchRows(rows),
    dispatchPendingRows: (rows) => outboxDispatcher.dispatchPendingRows(rows),
    // ephemeral 帧：仅本进程扇出（跨实例广播依赖 outbox+NOTIFY，ephemeral 不落库故为 best-effort，
    // 只有连到执行实例的客户端能收到）。
    // 注意：流式 delta 与重连快照帧走此通道（runtime-adapter commitKernelEvent/emitStreamSnapshot），
    // 因此 SaaS 多实例部署要求会话亲和（WS 连接须落在 lease owner 实例上），否则流式增量
    // 与在飞轮快照对该连接不可见——durable 检查点/终态帧不受此限（经 relay 跨实例可达）。
    dispatchEphemeral: (sessionId, event) => {
      realtimeEvents.publish(sessionId, event);
      return Promise.resolve();
    },
  });
  const fileHistory = conversationRuntime.createFileHistoryStorage(tenantId);
  const sessionFiles = conversationRuntime.createSessionFileStorage(tenantId);
  // 工具图片（view_image/MCP/媒体生成等 media）统一走会话附件通道（对象存储）。
  const toolImageSink = new SaaSToolImageSink(sessionFiles);
  const lifecycle = options.lifecycleEvents
    ? { tenantId, publish: options.lifecycleEvents }
    : null;
  const agentConfig = new AgentConfigService(
    conversationRuntime.createAgentConfigTeamStore(tenantId),
    lifecycle,
  );
  await agentConfig.initialize();
  // 产品形态补齐：default team 由产品层 ensure（内核不持有出厂内容）。
  await ensureDefaultTeam(agentConfig);
  const sessionApplication = new SaaSSessionApplication(
    tenantId,
    conversationRuntime.conversation,
    agentConfig,
    fileHistory,
    conversationRuntime.runs,
    conversationRuntime.outbox,
    conversationRuntime.workspaces,
    lifecycle,
    conversationRuntime.messageFeedback,
  );
  // SaaS providers are Postgres-backed; ModelAdapterService is a pure in-process projection.
  // Keep provider configuration process-local so create/update never writes providers.yaml under dataRoot.
  const modelAdapter = new ModelAdapterService({
    providersConfigPath: options.modelAdapterProvidersConfigPath ?? "",
  });
  // 插件 Provider 类型先于租户 provider 水合（prepareSaaSRuntimeContainer）注入。
  // SaaS system config is Postgres-backed; SystemConfigService is an in-process projection.
  const systemConfig = new SystemConfigService(
    conversationRuntime.createSystemConfigStore(tenantId),
  );
  await systemConfig.initialize();
  // 首条可见用户消息落库 → 异步 LLM 标题生成（会话入口 Agent 的 fast → default 档，
  // 无档位回落本租户系统 LLM）→ 回写投影。仓储进程级共享，通知按 tenantId 注册；
  // 容器关闭时注销。
  const conversationRepository = conversationRuntime.conversation;
  const sessionTitles = new SessionTitleService({
    updateSessionListTitle: (sessionId, title) => conversationRepository.updateSessionListTitle(sessionId, title),
    systemConfig,
    modelProviders: modelAdapter,
    getAgentLlmTiers: async (sessionId) => {
      const session = await conversationRepository.getSession(sessionId);
      if (!session?.team_snapshot) return null; // 存量未锚定会话：无入口锚点，回落系统 LLM
      const agent = agentConfig.getConfig(session.team_snapshot.entry_agent_name, {
        teamName: session.team_snapshot.team_name,
      });
      return agent?.llm_tiers ?? null;
    },
    // 会话级模型选择（default 档替换）与主智能体执行口径同源。
    getSessionSelectedLlm: async (sessionId) => {
      const session = await conversationRepository.getSession(sessionId);
      return readSessionRequestOverrides(session?.metadata).selectedLlm;
    },
    logger: options.logger
      ? { warn: (message, meta) => options.logger?.error({ tenantId, ...meta }, message) }
      : null,
  });
  conversationRepository.registerSessionTitleNotifier(tenantId, (sessionId, text) => {
    sessionTitles.notifyFirstVisibleUserMessage(sessionId, text);
  });
  const backgroundTasks = new BackgroundTaskService({
    repository: conversationRuntime.backgroundTasks,
    tenantId,
    clientEvents,
  });
  const goalStore = conversationRuntime.createGoalStore(tenantId);
  const taskTools = new TaskToolService(
    backgroundTasks,
    goalStore,
  );
  const permissionPolicyStore = new SaaSPermissionPolicyStore(tenantId, conversationRuntime.conversation);
  const sandboxFileBridge = new SaaSSandboxFileBridge(
    sessionFiles,
    conversationRuntime.createWorkspaceBlobStorage(tenantId),
  );
  const sandboxRuntime = new RunSandboxManager(
    tenantId,
    options.sandboxDriver,
    options.sandboxLeaseTimeoutSeconds,
    sandboxFileBridge,
  );
  // 插件 createRuntime 先于协调器构造，port 延迟绑定：先传稳定引用，容器建好后回填。
  const pendingInteractionBinding = createPendingInteractionBinding();
  const executionEnvironment = createSaaSExecutionEnvironment();
  const pluginRuntime = await options.plugins?.createRuntime({
    deploymentKind: "saas",
    tenantId,
    dataRoot,
    executionEnvironment,
    modelAdapter,
    systemConfig,
    agentConfig,
    sessions: sessionApplication,
    backgroundTasks,
    clientEvents,
    pendingInteractions: pendingInteractionBinding.port,
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.sandboxRuntime, sandboxRuntime, "@ragsystem/backend-saas")],
  });
  const pluginCapabilities = pluginRuntime?.capabilities ?? new CapabilityRegistry();
  pluginCapabilities.provide(
    EXECUTION_ENVIRONMENT_CAPABILITY,
    executionEnvironment,
    "@ragsystem/backend-saas",
  );
  // 图片请求归一化（内核共享实现）：view_image 等插件工具经 capability 消费；
  // 会话附件读取（SaaS 存储形态）暂走原字节，变体缓存由存储侧后续按需接入。
  pluginCapabilities.provide(
    IMAGE_REQUEST_NORMALIZER_CAPABILITY,
    new CoreImageRequestNormalizer(),
    "@ragsystem/backend-saas",
  );

  const runtime = createCoreRuntimeContainer({
    deploymentKind: "saas",
    tenantId,
    pluginCapabilities,
    dataRoot,
    toolImageSink,
    ...(options.logger ? { logger: options.logger } : {}),
    hooks: (registry: HookRegistry) => {
      options.hooks?.(registry);
      registry.on("run.finally", async ({ session, status }) => {
        // A recoverable interrupt resumes the same run and therefore retains its lease.
        if (status === "suspended") return;
        try {
          await sandboxRuntime.releaseRun(session.sessionId, session.runId, {
            collectOutputs: status === "completed" || status === "failed",
          });
        } catch (error) {
          options.logger?.error({
            tenantId,
            sessionId: session.sessionId,
            runId: session.runId,
            status,
            error: error instanceof Error ? error.message : String(error),
          }, "Sandbox output collection or cleanup failed");
          throw error;
        }
      });
    },
    ...(options.plugins ? { plugins: options.plugins } : {}),
    ...(pluginRuntime ? { pluginRuntime } : {}),
    clientEvents,
    runtimeStorage,
    delegationStore: conversationRuntime.createDelegationStore(tenantId),
    metricsStore: new SaaSAgentMetricsStore(tenantId, conversationRuntime.analytics),
    permissionPolicyStore,
    compressionHistory: conversationRuntime.conversation,
    executionSessions: sessionApplication,
    sessionApplication,
    realtimeEvents,
    agentConfig,
    modelAdapter,
    systemConfig,
    sessionFiles,
    executionStorage: createPostgresExecutionStorage({
      tenantId,
      agentMailbox: conversationRuntime.createAgentMailboxStore(tenantId),
      commitRunInput: (input) => runtimeStorage.operations.commitRunInput(input),
      conversation: conversationRuntime.conversation,
      clientEvents,
      createEventPersister: (context) => new AsyncKernelEventPersister(
        runtimeStorage,
        clientEvents,
        context,
        fileHistory,
      ),
      resultReader: {
        getRun: (sessionId, runId) => conversationRuntime.runs.getRun(tenantId, sessionId, runId),
        listRuns: (sessionId, limit, offset) => conversationRuntime.runs.listRuns(tenantId, sessionId, limit, offset),
        getMessageById: (sessionId, messageId) => conversationRuntime.conversation.getMessageById(sessionId, messageId),
      },
    }),
    pathAccessPolicyFactory: () => new PathApprovalService(),
    backgroundTasks,
    taskTools,
    goalStore,
    hostToolRegistry: new HostToolRegistry(),
    delegationPending: new DelegationPendingService(),
    eventDispatcher: outboxDispatcher,
    capabilities: {
      sessions: sessionApplication,
      fileHistory,
      sessionFiles,
    },
    closeInfrastructure: async () => {
      backgroundTasks.dispose();
      conversationRepository.unregisterSessionTitleNotifier(tenantId);
      // Shared process-level outbox dispatcher is owned by conversationRuntime.
      realtimeEvents.close();
      try {
        await sandboxRuntime.closeAll();
      } finally {
        pluginRuntime?.dispose();
      }
    },
  });
  pendingInteractionBinding.bind(runtime.pendingInteractions);
  return runtime;
}

/** Refresh tenant-scoped provider configuration before a leased runtime is used. */
export async function prepareSaaSRuntimeContainer(
  tenantId: TenantId,
  runtime: RuntimeContainer,
  conversationRuntime: SaaSConversationRuntimeHandle,
): Promise<void> {
  if (runtime.deploymentKind !== "saas") {
    throw new Error("SaaS runtime preparation requires a SaaS container");
  }
  runtime.modelAdapter.replaceRuntimeProviders(
    (await conversationRuntime.providers.listProviders(tenantId)).map(toModelProviderConfig),
  );
  await runtime.systemConfig.reload();
}
