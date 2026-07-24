import os from "node:os";
import path from "node:path";

import { MemoryStore } from "../../adapters/local/memory-store.js";
import { LocalMemoryToolRepository } from "./local-memory-tool-repository.js";
import { LocalBashToolService } from "../../tools/BashTool/BashExecution.js";
import { CodeExecutionToolService } from "../../tools/CodeExecutionTool/CodeExecution.js";
import { LocalDocumentToolService } from "../../tools/DocumentTools/DocumentExecution.js";
import { LocalSearchToolService } from "../../tools/LocalSearchTools/SearchExecution.js";
import { MemoryToolService } from "../../tools/MemoryTools/MemoryExecution.js";
import { SkillToolService } from "../../tools/SkillTools/SkillExecution.js";
import { TaskToolService } from "../../tools/TaskTools/TaskExecution.js";
import { AgentConfigService } from "../../services/agent/config/index.js";
import { MemoryContextSource } from "../../services/agent/memory/index.js";
import { ArtifactService } from "../../services/artifacts/artifact-service.js";
import { TransientArtifactService } from "../../services/artifacts/transient-artifact-service.js";
import { FileSystemConfigStore } from "../filesystem/config/file-system-config-store.js";
import { SystemConfigService } from "../../services/config/system-config-service.js";
import { McpService } from "../../services/integrations/mcp-service.js";
import { ModelAdapterService } from "../../services/integrations/model-adapter-service.js";
import { DocumentExtractDispatcher } from "../../services/knowledge/document-extract/dispatcher.js";
import { KnowledgeApplicationService } from "../../services/knowledge/knowledge-application-service.js";
import { AgentSessionApplication } from "../../services/sessions/index.js";
import { SkillLibraryService } from "../../services/skills/skill-library-service.js";
import { createConversationStore } from "./sqlite/conversation-store/index.js";
import { FileHistoryService } from "./files/file-history-service.js";
import { FileIndexService } from "./files/file-index-service.js";
import { LocalSessionFileLookup } from "./files/session-file-lookup.js";
import { createLocalVectorStore } from "./vector-store/vector-store-factory.js";
import { BackgroundTaskService } from "../../services/runtime/background-task-service.js";
import { createCoreRuntimeContainer } from "../../services/runtime/core-runtime-container.js";
import { DelegationPendingService } from "../../services/runtime/delegation-pending-service.js";
import { DurableClientEventPublisher } from "../../services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../services/runtime/event-outbox/dispatcher.js";
import { HostToolRegistry } from "../../services/runtime/host-tool-registry.js";
import { RealtimeEventHub } from "../../services/runtime/realtime-event-hub.js";
import type { LocalRuntimeContainer } from "../../contracts/runtime/runtime-container.js";
import type { LocalRuntimeContainerOptions } from "./runtime-options.js";
import { SessionNotificationQueue } from "../../services/runtime/session-notification-queue.js";
import { LocalAsyncKnowledgeMarkdownPipeline } from "./knowledge/local-async-knowledge-markdown-pipeline.js";
import { createLocalExecutionStorage } from "./local-execution-storage.js";
import { LocalGoalStore } from "./local-goal-store.js";
import { PathApprovalService } from "../../services/runtime/path-approval-service.js";
import { SqliteRuntimeStorage } from "./sqlite-runtime-storage.js";
import { LocalSessionApplication } from "./application/session/local-session-application.js";
import { LocalAnalyticsApplication } from "./application/analytics/local-analytics-application.js";
import { LocalArtifactApplication } from "./application/artifact/local-artifact-application.js";
import { LocalExecutionReadApplication } from "./application/execution-read/local-execution-read-application.js";
import { LocalFileChangeApplication } from "./application/file-change/local-file-change-application.js";
import { LocalMemoryApplication } from "./application/memory/local-memory-application.js";
import { LocalMonitoringApplication } from "./application/monitoring/local-monitoring-application.js";
import { LocalSessionFileApplication } from "./application/session-file/local-session-file-application.js";
import { KnowledgeHttpApplication } from "../../services/knowledge/knowledge-http-application.js";
import { FileAgentConfigTeamStore } from "../filesystem/agent/file-team-store.js";
import { FilesystemSkillPackageStore } from "../filesystem/skills/filesystem-skill-package-store.js";
import { LocalMemoryContextRepository } from "./local-memory-context-repository.js";
import { LocalMemoryCandidateCommandAdapter } from "./local-memory-candidate-command-adapter.js";
import { LocalCompressionHistoryAdapter } from "./local-compression-history-adapter.js";
import { LocalAgentDelegationStoreAdapter } from "./local-agent-delegation-store-adapter.js";
import { LocalAgentMetricsStoreAdapter } from "./local-agent-metrics-store-adapter.js";
import { LocalOutboxStoreAdapter } from "./local-outbox-store-adapter.js";
import { LocalDocumentEditHistoryAdapter } from "./files/local-document-edit-history-adapter.js";
import { LocalAgentSessionRepository } from "./local-agent-session-repository.js";
import { LocalSessionHistoryAdapter } from "./local-session-history-adapter.js";

/** Create the filesystem, SQLite, and host-tool backed runtime used by local deployments. */
export async function createLocalRuntimeContainer(options: LocalRuntimeContainerOptions): Promise<LocalRuntimeContainer> {
  const dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  const conversationStore = createConversationStore({ dbPath: options.dbPath, dataRoot });
  const fileHistory = new FileHistoryService({ dataRoot });
  const transientArtifacts = new TransientArtifactService(dataRoot);
  transientArtifacts.startPruning();
  const sessionApplication = new AgentSessionApplication(
    new LocalAgentSessionRepository(conversationStore),
    new LocalSessionHistoryAdapter(fileHistory),
    transientArtifacts,
  );
  const requestSessionApplication = new LocalSessionApplication(options.tenantId, sessionApplication, conversationStore);
  const realtimeEvents = new RealtimeEventHub();
  const outboxDispatcher = new OutboxDispatcher(new LocalOutboxStoreAdapter(conversationStore), realtimeEvents);
  if (options.startOutboxDispatcher ?? true) {
    outboxDispatcher.start(options.outboxDispatcherIntervalMs);
  }
  const runtimeStorage = options.runtimeStorageFactory?.(options.tenantId)
    ?? new SqliteRuntimeStorage(options.tenantId, conversationStore);
  const localClientEvents = new DurableClientEventPublisher(runtimeStorage, {
    dispatchRows: (rows) => outboxDispatcher.dispatchRows(rows),
  });
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

  const knowledgeDriver = createLocalVectorStore(dataRoot, { inMemory: options.dbPath === ":memory:" });
  const documentExtractDispatcher = new DocumentExtractDispatcher(systemConfig.getDocumentExtractionConfig());
  const knowledgeService = new KnowledgeApplicationService(
    options.tenantId,
    modelAdapter,
    knowledgeDriver,
    knowledgeDriver,
    options.embedderFactory,
  );
  const knowledgeFiles = knowledgeDriver;
  const knowledgeMarkdown = new LocalAsyncKnowledgeMarkdownPipeline(knowledgeFiles, documentExtractDispatcher);
  const knowledge = knowledgeService;
  const artifacts = new ArtifactService({ dataRoot: options.dataRoot });
  const memoryStore = new MemoryStore({ dataRoot: options.dataRoot });
  const memoryToolRepository = new LocalMemoryToolRepository(memoryStore);
  const memoryContextRepository = new LocalMemoryContextRepository(memoryStore);
  const memoryBindings = options.memoryBindingsFactory?.({
    tenantId: options.tenantId,
    dataRoot,
    getMemoryConfig: () => systemConfig.getMemoryConfig(),
    memoryRepository: memoryStore,
    sessions: sessionApplication,
  }) ?? {
    tools: new MemoryToolService(
      memoryToolRepository,
      sessionApplication,
      new LocalMemoryCandidateCommandAdapter(conversationStore),
      options.tenantId,
    ),
    createContextSource: (input) => new MemoryContextSource(
      input.sessions,
      memoryContextRepository,
      input.memory,
      input.agentName,
      {
        indexMaxLines: input.memoryConfig.index_max_lines,
        indexMaxChars: input.memoryConfig.index_max_chars,
      },
    ),
  };
  const hostToolsEnabled = options.hostToolsEnabled !== false;
  const documentTools = hostToolsEnabled ? new LocalDocumentToolService({
    dataRoot: options.dataRoot,
    fileHistory: new LocalDocumentEditHistoryAdapter(fileHistory),
  }) : null;
  const notificationQueue = new SessionNotificationQueue();
  const backgroundTasks = new BackgroundTaskService({
    notificationQueue,
    ...(options.asyncBackgroundTasks ? { repository: options.asyncBackgroundTasks, tenantId: options.tenantId } : {}),
  });
  const toolsConfig = systemConfig.getToolsConfig();
  const codeExecutionTools = hostToolsEnabled ? new CodeExecutionToolService({
    dataRoot: options.dataRoot,
    defaultTimeoutSeconds: toolsConfig.code_default_timeout,
    maxTimeoutSeconds: toolsConfig.code_max_timeout,
  }) : null;
  const userGlobalSkillsRoot = path.join(dataRoot, "skills");
  const skillPackageStore = new FilesystemSkillPackageStore(userGlobalSkillsRoot);
  const skillTools = new SkillToolService({
    dataRoot: options.dataRoot,
    userGlobalSkillsRoot,
    agentConfig,
    artifacts,
    backgroundTasks,
    clientEvents,
    packageStore: skillPackageStore,
  });
  agentConfig.setSkillToolService(skillTools);
  const skillLibrary = new SkillLibraryService(skillTools, skillPackageStore);
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

  const localKnowledge = new KnowledgeHttpApplication(knowledgeService, knowledgeFiles, knowledgeMarkdown);
  const localArtifacts = new LocalArtifactApplication(artifacts);
  const localAnalytics = new LocalAnalyticsApplication(conversationStore);
  const localMonitoring = new LocalMonitoringApplication(conversationStore);
  const localSessionFiles = new LocalSessionFileApplication(fileIndex);
  const localFileChanges = new LocalFileChangeApplication(fileHistory);
  let localExecutionRead: LocalExecutionReadApplication | null = null;

  const runtime = createCoreRuntimeContainer({
    deploymentKind: "local",
    tenantId: options.tenantId,
    dataRoot,
    getMemoryConfig: () => systemConfig.getMemoryConfig(),
    logger: options.logger,
    ...(options.hooks ? { hooks: options.hooks } : {}),
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
    knowledge,
    memoryBindings,
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
    skillTools,
    skillLibrary,
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
      knowledge: localKnowledge,
      artifacts: localArtifacts,
      analytics: localAnalytics,
      monitoring: localMonitoring,
      get executionRead() {
        if (!localExecutionRead) throw new Error("Local execution read application is not initialized");
        return localExecutionRead;
      },
      sessionFiles: localSessionFiles,
      fileChanges: localFileChanges,
      createMemoryApplication: (input) => new LocalMemoryApplication(
        options.tenantId,
        memoryStore,
        conversationStore,
        input.viewerUserId,
        input.viewerSessionIds,
      ),
    },
    closeInfrastructure: () => {
      backgroundTasks.dispose();
      transientArtifacts.stopPruning();
      outboxDispatcher.stop();
      mcp.close();
      knowledgeDriver.close();
      fileIndex.close();
      conversationStore.close();
    },
  });
  localExecutionRead = new LocalExecutionReadApplication(runtime.agentExecution, conversationStore);
  options.onInfrastructureCreated?.({ conversationStore, memoryStore, sessions: sessionApplication });
  return runtime;
}
