import os from "node:os";
import path from "node:path";

import { TaskToolService } from "@ragsystem/backend-core/tools/TaskTools/TaskExecution.js";
import { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";
import { ensureDefaultTeam } from "./composition/default-team.js";
import { TransientSessionResourceService } from "./session-resources/transient-session-resource-service.js";
import { FileSystemConfigStore } from "../filesystem/config/file-system-config-store.js";
import { SystemConfigService } from "@ragsystem/backend-core/services/config/system-config-service.js";
import { ModelAdapterService } from "@ragsystem/backend-core/services/integrations/model-adapter-service.js";
import { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { EXECUTION_ENVIRONMENT_CAPABILITY, createLocalExecutionEnvironment } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";
import { AgentSessionApplication } from "@ragsystem/backend-core/services/sessions/index.js";
import { SessionTitleService } from "@ragsystem/backend-core/services/sessions/session-title-service.js";
import { readSessionRequestOverrides } from "@ragsystem/backend-core/services/agent/execution/session-request-overrides.js";
import { createConversationStore } from "./sqlite/conversation-store/index.js";
import { FileHistoryService } from "./files/file-history-service.js";
import { FileIndexService } from "./files/file-index-service.js";
import { LocalSessionFileLookup } from "./files/session-file-lookup.js";
import { BackgroundTaskService } from "@ragsystem/backend-core/services/runtime/background-task-service.js";
import { createCoreRuntimeContainer } from "@ragsystem/backend-core/services/runtime/core-runtime-container.js";
import { createPendingInteractionBinding } from "@ragsystem/backend-core/services/runtime/pending-interaction-binding.js";
import { DelegationPendingService } from "@ragsystem/backend-core/services/runtime/delegation-pending-service.js";
import { DurableClientEventPublisher } from "@ragsystem/backend-core/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "@ragsystem/backend-core/services/runtime/event-outbox/dispatcher.js";
import { HostToolRegistry } from "@ragsystem/backend-core/services/runtime/host-tool-registry.js";
import { RealtimeEventHub } from "@ragsystem/backend-core/services/runtime/realtime-event-hub.js";
import type { LocalRuntimeContainer } from "@ragsystem/backend-core/contracts/runtime/runtime-container.js";
import type { LocalRuntimeContainerOptions } from "./runtime-options.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { createLocalExecutionStorage } from "./local-execution-storage.js";
import { LocalGoalStore } from "./local-goal-store.js";
import { PathApprovalService } from "@ragsystem/backend-core/services/runtime/path-approval-service.js";
import { SqliteRuntimeStorage } from "./sqlite-runtime-storage.js";
import { LocalSessionApplication } from "./application/session/local-session-application.js";
import { LocalAnalyticsApplication } from "./application/analytics/local-analytics-application.js";
import { LocalExecutionReadApplication } from "./application/execution-read/local-execution-read-application.js";
import { LocalFileChangeApplication } from "./application/file-change/local-file-change-application.js";
import { LocalMonitoringApplication } from "./application/monitoring/local-monitoring-application.js";
import { LocalSessionFileApplication } from "./application/session-file/local-session-file-application.js";
import { FileAgentConfigTeamStore } from "../filesystem/agent/file-team-store.js";
import { LocalCompressionHistoryAdapter } from "./local-compression-history-adapter.js";
import { LocalAgentDelegationStoreAdapter } from "./local-agent-delegation-store-adapter.js";
import { LocalAgentMetricsStoreAdapter } from "./local-agent-metrics-store-adapter.js";
import { LocalOutboxStoreAdapter } from "./local-outbox-store-adapter.js";
import { LocalAgentSessionRepository } from "./local-agent-session-repository.js";
import { LocalSessionHistoryAdapter } from "./local-session-history-adapter.js";
import { LocalAgentMailboxStoreAdapter } from "./local-agent-mailbox-store-adapter.js";

/** Create the filesystem, SQLite, and host-tool backed runtime used by local deployments. */

/** delivered outbox 行保留窗口：覆盖 stale-cursor 重连的人类时间尺度（睡眠/隔夜）。 */
const OUTBOX_DELIVERED_RETENTION_MS = 24 * 60 * 60_000;
/** GC 节奏：低频批量清理，与投递路径解耦。 */
const OUTBOX_GC_INTERVAL_MS = 60_000;
export async function createLocalRuntimeContainer(options: LocalRuntimeContainerOptions): Promise<LocalRuntimeContainer> {
  const dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  const conversationStore = createConversationStore({ dbPath: options.dbPath, dataRoot });
  const lifecycle = options.lifecycleEvents
    ? { tenantId: options.tenantId, publish: options.lifecycleEvents }
    : null;
  const agentConfig = new AgentConfigService(
    new FileAgentConfigTeamStore({ dataRoot: options.dataRoot, configRoot: options.agentConfigRoot }),
    lifecycle,
  );
  await agentConfig.initialize();
  // 产品形态补齐：default team 由产品层 ensure（内核不持有出厂内容）。
  await ensureDefaultTeam(agentConfig);
  const agentMailbox = new LocalAgentMailboxStoreAdapter(conversationStore);
  // maxSeqProvider：编辑追踪盖 tracked_seq 戳，rewind 只冲刷锚点之后的编辑（无关回退误毁中断 run 工作的事故修复）。
  const fileHistory = new FileHistoryService({
    dataRoot,
    maxSeqProvider: (sessionId) => conversationStore.getMaxSeq(sessionId),
  });
  // 目录服务唯一实例：工具执行、插件上下文、工作区文件读取共用同一权威。
  const executionEnvironment = createLocalExecutionEnvironment(dataRoot);
  const transientResources = new TransientSessionResourceService(dataRoot);
  transientResources.startPruning();
  const sessionApplication = new AgentSessionApplication(
    new LocalAgentSessionRepository(conversationStore),
    new LocalSessionHistoryAdapter(fileHistory),
    transientResources,
    async (session) => session.workspace_id
      ? conversationStore.getWorkspaceById(session.tenant_id, session.workspace_id)?.root_path ?? null
      : null,
    agentConfig,
    lifecycle,
  );
  const requestSessionApplication = new LocalSessionApplication(options.tenantId, sessionApplication, conversationStore, agentConfig, executionEnvironment);
  const realtimeEvents = new RealtimeEventHub();
  const outboxDispatcher = new OutboxDispatcher(new LocalOutboxStoreAdapter(conversationStore), realtimeEvents);
  const runtimeStorage = options.runtimeStorageFactory?.(options.tenantId)
    ?? new SqliteRuntimeStorage(options.tenantId, conversationStore);
  const localClientEvents = new DurableClientEventPublisher(runtimeStorage, {
    dispatchRows: (rows) => outboxDispatcher.dispatchRows(rows),
    // ephemeral 帧（插件进度等）：绕过 outbox 直接实时扇出，不落库不回放。
    dispatchEphemeral: (sessionId, event) => {
      realtimeEvents.publish(sessionId, event);
      return Promise.resolve();
    },
  });
  if (runtimeStorage instanceof SqliteRuntimeStorage) {
    const recovered = await runtimeStorage.recoverOrphanedRuns();
    await localClientEvents.deliver(recovered.records.map((record) => record.outbox));
  }
  if (options.startOutboxDispatcher ?? true) {
    outboxDispatcher.start(options.outboxDispatcherIntervalMs);
  }
  // delivered outbox 行自动 GC：保留窗口覆盖 stale-cursor 重连；非终态 run 的行由
  // deleteDeliveredOutbox 谓词排除（它们是活跃 run 的 attach 回放源）。无清理会无限膨胀。
  const outboxGcTimer = setInterval(() => {
    try {
      conversationStore.deleteDeliveredOutbox({
        before: new Date(Date.now() - OUTBOX_DELIVERED_RETENTION_MS).toISOString(),
        limit: 10_000,
      });
    } catch {
      // GC 是运维性任务，失败留待下一轮。
    }
  }, OUTBOX_GC_INTERVAL_MS);
  outboxGcTimer.unref?.();
  const clientEvents = options.clientEventsFactory?.(options.tenantId, realtimeEvents, runtimeStorage)
    ?? localClientEvents;
  const modelAdapter = new ModelAdapterService({
    dataRoot: options.dataRoot,
    providersConfigPath: options.modelAdapterProvidersConfigPath,
  });
  // 插件 Provider 类型先于 provider 水合/请求注入；providers.yaml 中该类型条目随之装载。
  const systemConfig = new SystemConfigService(new FileSystemConfigStore({
    dataRoot: options.dataRoot,
    configPath: options.systemConfigPath,
  }));
  await systemConfig.initialize();
  // 首条可见用户消息落库 → 异步 LLM 标题生成 → 回写列表投影（override 优先）。
  // 调用目标：会话入口 Agent 的 fast → default 档，无档位回落系统 LLM。
  // 失败静默退回首条消息截断兜底，不进入任何用户可见错误路径。
  const sessionTitles = new SessionTitleService({
    updateSessionListTitle: (sessionId, title) => {
      conversationStore.updateSessionListTitle(sessionId, title);
    },
    systemConfig,
    modelProviders: modelAdapter,
    getAgentLlmTiers: (sessionId) => {
      const session = conversationStore.getSession(sessionId);
      if (!session?.team_snapshot) return null; // 存量未锚定会话：无入口锚点，回落系统 LLM
      const agent = agentConfig.getConfig(session.team_snapshot.entry_agent_name, {
        teamName: session.team_snapshot.team_name,
      });
      return agent?.llm_tiers ?? null;
    },
    // 会话级模型选择（default 档替换）与主智能体执行口径同源。
    getSessionSelectedLlm: (sessionId) =>
      readSessionRequestOverrides(conversationStore.getSession(sessionId)?.metadata).selectedLlm,
  });
  conversationStore.setFirstVisibleUserMessageNotifier((sessionId, text) => {
    sessionTitles.notifyFirstVisibleUserMessage(sessionId, text);
  });
  const fileIndex = new FileIndexService({ dbPath: options.dbPath, dataRoot: options.dataRoot });

  const hostToolsEnabled = options.hostToolsEnabled !== false;
  const backgroundTasks = new BackgroundTaskService({
    clientEvents,
    ...(options.asyncBackgroundTasks ? { repository: options.asyncBackgroundTasks, tenantId: options.tenantId } : {}),
  });
  // 插件 createRuntime 先于协调器构造，port 延迟绑定：先传稳定引用，容器建好后回填。
  const pendingInteractionBinding = createPendingInteractionBinding();
  const pluginRuntime = await options.plugins?.createRuntime({
    deploymentKind: "local",
    tenantId: options.tenantId,
    dataRoot,
    executionEnvironment,
    modelAdapter,
    systemConfig,
    agentConfig,
    sessions: requestSessionApplication,
    backgroundTasks,
    clientEvents,
    pendingInteractions: pendingInteractionBinding.port,
    resources: [
      provideBackendResource(
        BACKEND_HOST_RESOURCES.toolPolicy,
        { executionToolsEnabled: hostToolsEnabled },
        "@ragsystem/backend-local",
      ),
      provideBackendResource(BACKEND_HOST_RESOURCES.fileEditHistory, fileHistory, "@ragsystem/backend-local"),
    ],
  });
  const goalStore = new LocalGoalStore(options.tenantId, conversationStore);
  const taskTools = new TaskToolService(
    backgroundTasks,
    goalStore,
  );
  const hostToolRegistry = new HostToolRegistry();
  const delegationPending = new DelegationPendingService();

  const pluginCapabilities = pluginRuntime?.capabilities ?? new CapabilityRegistry();
  pluginCapabilities.provide(
    EXECUTION_ENVIRONMENT_CAPABILITY,
    executionEnvironment,
    "@ragsystem/backend-local",
  );
  const localAnalytics = new LocalAnalyticsApplication(conversationStore);
  const localMonitoring = new LocalMonitoringApplication(conversationStore);
  const localSessionFiles = new LocalSessionFileApplication(fileIndex);
  const localFileChanges = new LocalFileChangeApplication(fileHistory);
  let localExecutionRead: LocalExecutionReadApplication | null = null;

  const runtime = createCoreRuntimeContainer({
    deploymentKind: "local",
    tenantId: options.tenantId,
    pluginCapabilities,
    dataRoot,
    logger: options.logger,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.plugins ? { plugins: options.plugins } : {}),
    ...(pluginRuntime ? { pluginRuntime } : {}),
    delegationStore: new LocalAgentDelegationStoreAdapter(conversationStore),
    metricsStore: new LocalAgentMetricsStoreAdapter(conversationStore),
    permissionPolicyStore: conversationStore,
    compressionHistory: new LocalCompressionHistoryAdapter(conversationStore),
    executionSessions: sessionApplication,
    sessionApplication: requestSessionApplication,
    realtimeEvents,
    agentConfig,
    modelAdapter,
    systemConfig,
    sessionFiles: new LocalSessionFileLookup(fileIndex),
    runtimeStorage,
    executionStorage: options.executionStorage
      ?? options.executionStorageFactory?.({ tenantId: options.tenantId, runtimeStorage, clientEvents })
      ?? createLocalExecutionStorage({
        tenantId: options.tenantId,
        conversation: conversationStore,
        runtimeStorage,
        clientEvents: localClientEvents,
        fileHistory: new LocalSessionHistoryAdapter(fileHistory),
      }),
    pathAccessPolicyFactory: options.pathAccessPolicyFactory ?? (() => new PathApprovalService()),
    backgroundTasks,
    taskTools,
    goalStore,
    hostToolRegistry,
    delegationPending,
    eventDispatcher: outboxDispatcher,
    clientEvents,
    capabilities: {
      createSessionApplication: (tenantId) => new LocalSessionApplication(
        tenantId,
        sessionApplication,
        conversationStore,
        agentConfig,
        executionEnvironment,
      ),
      analytics: localAnalytics,
      monitoring: localMonitoring,
      get executionRead() {
        if (!localExecutionRead) throw new Error("Local execution read application is not initialized");
        return localExecutionRead;
      },
      sessionFiles: localSessionFiles,
      fileChanges: localFileChanges,
    },
    closeInfrastructure: () => {
      backgroundTasks.dispose();
      transientResources.stopPruning();
      clearInterval(outboxGcTimer);
      outboxDispatcher.stop();
      pluginRuntime?.dispose();
      fileIndex.close();
      conversationStore.close();
    },
  });
  pendingInteractionBinding.bind(runtime.pendingInteractions);
  localExecutionRead = new LocalExecutionReadApplication(runtime.agentExecution, conversationStore);
  options.onInfrastructureCreated?.({ conversationStore, agentMailbox, sessions: sessionApplication });
  return runtime;
}
