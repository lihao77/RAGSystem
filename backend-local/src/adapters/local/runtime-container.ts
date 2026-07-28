import os from "node:os";
import path from "node:path";

import { LocalBashToolService } from "@ragsystem/backend-core/tools/BashTool/BashExecution.js";
import { CodeExecutionToolService } from "@ragsystem/backend-core/tools/CodeExecutionTool/CodeExecution.js";
import { LocalDocumentToolService } from "@ragsystem/backend-core/tools/DocumentTools/DocumentExecution.js";
import { LocalSearchToolService } from "@ragsystem/backend-core/tools/LocalSearchTools/SearchExecution.js";
import { TaskToolService } from "@ragsystem/backend-core/tools/TaskTools/TaskExecution.js";
import { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";
import { TransientSessionResourceService } from "./session-resources/transient-session-resource-service.js";
import { FileSystemConfigStore } from "../filesystem/config/file-system-config-store.js";
import { SystemConfigService } from "@ragsystem/backend-core/services/config/system-config-service.js";
import { McpService } from "@ragsystem/backend-core/services/integrations/mcp-service.js";
import { ModelAdapterService } from "@ragsystem/backend-core/services/integrations/model-adapter-service.js";
import { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { AgentSessionApplication } from "@ragsystem/backend-core/services/sessions/index.js";
import { createConversationStore } from "./sqlite/conversation-store/index.js";
import { FileHistoryService } from "./files/file-history-service.js";
import { FileIndexService } from "./files/file-index-service.js";
import { LocalSessionFileLookup } from "./files/session-file-lookup.js";
import { BackgroundTaskService } from "@ragsystem/backend-core/services/runtime/background-task-service.js";
import { createCoreRuntimeContainer } from "@ragsystem/backend-core/services/runtime/core-runtime-container.js";
import { DelegationPendingService } from "@ragsystem/backend-core/services/runtime/delegation-pending-service.js";
import { DurableClientEventPublisher } from "@ragsystem/backend-core/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "@ragsystem/backend-core/services/runtime/event-outbox/dispatcher.js";
import { HostToolRegistry } from "@ragsystem/backend-core/services/runtime/host-tool-registry.js";
import { RealtimeEventHub } from "@ragsystem/backend-core/services/runtime/realtime-event-hub.js";
import type { LocalRuntimeContainer } from "@ragsystem/backend-core/contracts/runtime/runtime-container.js";
import type { LocalRuntimeContainerOptions } from "./runtime-options.js";
import { SessionNotificationQueue } from "@ragsystem/backend-core/services/runtime/session-notification-queue.js";
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
import { LocalDocumentEditHistoryAdapter } from "./files/local-document-edit-history-adapter.js";
import { LocalAgentSessionRepository } from "./local-agent-session-repository.js";
import { LocalSessionHistoryAdapter } from "./local-session-history-adapter.js";
import { buildExecutionEnvelopeRunStep } from "@ragsystem/backend-core/services/runtime/event-outbox/execution-envelope-archive.js";

/** Create the filesystem, SQLite, and host-tool backed runtime used by local deployments. */
export async function createLocalRuntimeContainer(options: LocalRuntimeContainerOptions): Promise<LocalRuntimeContainer> {
  const dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  const conversationStore = createConversationStore({ dbPath: options.dbPath, dataRoot });
  const fileHistory = new FileHistoryService({ dataRoot });
  const transientResources = new TransientSessionResourceService(dataRoot);
  transientResources.startPruning();
  const sessionApplication = new AgentSessionApplication(
    new LocalAgentSessionRepository(conversationStore),
    new LocalSessionHistoryAdapter(fileHistory),
    transientResources,
    async (session) => session.workspace_id
      ? conversationStore.getWorkspaceById(session.tenant_id, session.workspace_id)?.root_path ?? null
      : null,
  );
  const requestSessionApplication = new LocalSessionApplication(options.tenantId, sessionApplication, conversationStore);
  const realtimeEvents = new RealtimeEventHub();
  const outboxDispatcher = new OutboxDispatcher(new LocalOutboxStoreAdapter(conversationStore), realtimeEvents);
  const runtimeStorage = options.runtimeStorageFactory?.(options.tenantId)
    ?? new SqliteRuntimeStorage(options.tenantId, conversationStore);
  const localClientEvents = new DurableClientEventPublisher(runtimeStorage, {
    dispatchRows: (rows) => outboxDispatcher.dispatchRows(rows),
  });
  if (runtimeStorage instanceof SqliteRuntimeStorage) {
    const recovered = await runtimeStorage.recoverOrphanedRuns((run) => {
      const eventId = `${run.runId}:local-startup-recovery:run_ended`;
      const event = {
        type: "run_ended" as const,
        session_id: run.sessionId,
        run_id: run.runId,
        payload: { status: "interrupted" as const, reason: "backend_restarted" },
      };
      return {
        step: buildExecutionEnvelopeRunStep(run.sessionId, run.runId, event, eventId),
        outbox: {
          sessionId: run.sessionId,
          runId: run.runId,
          eventId,
          eventType: "client.run_ended",
          aggregateType: "run",
          aggregateId: run.runId,
          payload: { client_event: event },
        },
      };
    });
    await localClientEvents.deliver(recovered.records.map((record) => record.outbox));
  }
  if (options.startOutboxDispatcher ?? true) {
    outboxDispatcher.start(options.outboxDispatcherIntervalMs);
  }
  const clientEvents = options.clientEventsFactory?.(options.tenantId, realtimeEvents, runtimeStorage)
    ?? localClientEvents;
  const agentConfig = new AgentConfigService(new FileAgentConfigTeamStore({ dataRoot: options.dataRoot, configRoot: options.agentConfigRoot }));
  await agentConfig.initialize();
  const modelAdapter = new ModelAdapterService({
    dataRoot: options.dataRoot,
    providersConfigPath: options.modelAdapterProvidersConfigPath,
  });
  const systemConfig = new SystemConfigService(new FileSystemConfigStore({
    dataRoot: options.dataRoot,
    configPath: options.systemConfigPath,
  }));
  await systemConfig.initialize();
  const mcp = new McpService({ dataRoot: options.dataRoot, configPath: options.mcpConfigPath });
  void mcp.autoConnectEnabledServers();
  agentConfig.setMcpService(mcp);
  const fileIndex = new FileIndexService({ dbPath: options.dbPath, dataRoot: options.dataRoot });

  const hostToolsEnabled = options.hostToolsEnabled !== false;
  const documentTools = hostToolsEnabled ? new LocalDocumentToolService({
    dataRoot: options.dataRoot,
    fileHistory: new LocalDocumentEditHistoryAdapter(fileHistory),
  }) : null;
  const notificationQueue = new SessionNotificationQueue();
  const backgroundTasks = new BackgroundTaskService({
    notificationQueue,
    clientEvents,
    ...(options.asyncBackgroundTasks ? { repository: options.asyncBackgroundTasks, tenantId: options.tenantId } : {}),
  });
  const pluginRuntime = await options.plugins?.createRuntime({
    deploymentKind: "local",
    tenantId: options.tenantId,
    dataRoot,
    modelAdapter,
    systemConfig,
    agentConfig,
    sessions: requestSessionApplication,
    backgroundTasks,
    clientEvents,
  });
  const toolsConfig = systemConfig.getToolsConfig();
  const codeExecutionTools = hostToolsEnabled ? new CodeExecutionToolService({
    dataRoot: options.dataRoot,
    defaultTimeoutSeconds: toolsConfig.code_default_timeout,
    maxTimeoutSeconds: toolsConfig.code_max_timeout,
  }) : null;
  const searchTools = hostToolsEnabled ? new LocalSearchToolService({ dataRoot: options.dataRoot }) : null;
  const bashTools = hostToolsEnabled ? new LocalBashToolService({
    dataRoot: options.dataRoot,
    defaultTimeoutSeconds: toolsConfig.bash_default_timeout,
    maxTimeoutSeconds: toolsConfig.bash_max_timeout,
    maxOutputChars: toolsConfig.bash_max_output,
    backgroundTasks,
    clientEvents,
  }) : null;
  const goalStore = new LocalGoalStore(options.tenantId, conversationStore);
  const taskTools = new TaskToolService(
    backgroundTasks,
    notificationQueue,
    goalStore,
  );
  const hostToolRegistry = new HostToolRegistry();
  const delegationPending = new DelegationPendingService();

  const pluginCapabilities = pluginRuntime?.capabilities ?? new CapabilityRegistry();
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
    mcp,
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
    documentTools,
    codeExecutionTools,
    searchTools,
    bashTools,
    backgroundTasks,
    taskTools,
    goalStore,
    notificationQueue,
    hostToolRegistry,
    delegationPending,
    eventDispatcher: outboxDispatcher,
    clientEvents,
    capabilities: {
      createSessionApplication: (tenantId) => new LocalSessionApplication(
        tenantId,
        sessionApplication,
        conversationStore,
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
      outboxDispatcher.stop();
      mcp.close();
      pluginRuntime?.dispose();
      fileIndex.close();
      conversationStore.close();
    },
  });
  localExecutionRead = new LocalExecutionReadApplication(runtime.agentExecution, conversationStore);
  options.onInfrastructureCreated?.({ conversationStore, sessions: sessionApplication });
  return runtime;
}
