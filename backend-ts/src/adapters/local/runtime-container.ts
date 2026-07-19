import os from "node:os";
import path from "node:path";

import { MemoryStore } from "../../adapters/local/memory-store.js";
import { LocalBashToolService } from "../../tools/BashTool/BashExecution.js";
import { CodeExecutionToolService } from "../../tools/CodeExecutionTool/CodeExecution.js";
import { LocalDocumentToolService } from "../../tools/DocumentTools/DocumentExecution.js";
import { LocalSearchToolService } from "../../tools/LocalSearchTools/SearchExecution.js";
import { MemoryToolService } from "../../tools/MemoryTools/MemoryExecution.js";
import { SkillToolService } from "../../tools/SkillTools/SkillExecution.js";
import { TaskToolService } from "../../tools/TaskTools/TaskExecution.js";
import { AgentConfigService } from "../../services/agent/config/index.js";
import { MemoryIndexContextSource } from "../../services/agent/memory/index.js";
import { ArtifactService } from "../../services/artifacts/artifact-service.js";
import { TransientArtifactService } from "../../services/artifacts/transient-artifact-service.js";
import { SystemConfigService } from "../../services/config/system-config-service.js";
import { McpService } from "../../services/integrations/mcp-service.js";
import { ModelAdapterService } from "../../services/integrations/model-adapter-service.js";
import { DocumentExtractDispatcher } from "../../services/knowledge/document-extract/dispatcher.js";
import { EmbeddingModelService } from "../../services/knowledge/embedding-model-service.js";
import { KnowledgeBaseService } from "../../services/knowledge/knowledge-base-service.js";
import { AgentSessionApplication } from "../../services/sessions/index.js";
import { SkillLibraryService } from "../../services/skills/skill-library-service.js";
import { createConversationStore } from "../../services/stores/conversation-store/index.js";
import { FileHistoryService } from "../../services/stores/file-history-service.js";
import { FileIndexService } from "../../services/stores/file-index-service.js";
import { createVectorStoreFromConfig } from "../../services/vector-store/vector-store-factory.js";
import { BackgroundTaskService } from "../../services/runtime/background-task-service.js";
import { createCoreRuntimeContainer } from "../../services/runtime/core-runtime-container.js";
import { DelegationPendingService } from "../../services/runtime/delegation-pending-service.js";
import { DurableClientEventPublisher } from "../../services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../services/runtime/event-outbox/dispatcher.js";
import { HostToolRegistry } from "../../services/runtime/host-tool-registry.js";
import { PendingInteractionService } from "../../services/runtime/pending-interaction-service.js";
import { PermissionPolicyService } from "../../services/runtime/permission-policy-service.js";
import { RealtimeEventHub } from "../../services/runtime/realtime-event-hub.js";
import type { LocalRuntimeContainerOptions, RuntimeContainer } from "../../contracts/runtime-container.js";
import { SessionNotificationQueue } from "../../services/runtime/session-notification-queue.js";
import { LocalKnowledgeQueryAdapter } from "./local-knowledge-query-adapter.js";
import { createLocalExecutionStorage } from "./local-execution-storage.js";

/** Create the filesystem, SQLite, and host-tool backed runtime used by local deployments. */
export function createLocalRuntimeContainer(options: LocalRuntimeContainerOptions): RuntimeContainer {
  const dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  const conversationStore = createConversationStore({ dbPath: options.dbPath, dataRoot });
  const fileHistory = new FileHistoryService({ dataRoot });
  const transientArtifacts = new TransientArtifactService(dataRoot);
  transientArtifacts.startPruning();
  const sessionApplication = new AgentSessionApplication(conversationStore, fileHistory, transientArtifacts);
  const realtimeEvents = new RealtimeEventHub();
  const asyncClientEvents = options.asyncClientEventsFactory?.(realtimeEvents);
  const outboxDispatcher = new OutboxDispatcher(conversationStore, realtimeEvents);
  if (options.startOutboxDispatcher ?? true) {
    outboxDispatcher.start(options.outboxDispatcherIntervalMs);
  }
  const clientEvents = new DurableClientEventPublisher(conversationStore, outboxDispatcher);
  const permissionPolicy = new PermissionPolicyService(conversationStore);
  const agentConfig = new AgentConfigService({ dataRoot: options.dataRoot, configRoot: options.agentConfigRoot });
  const modelAdapter = new ModelAdapterService({
    dataRoot: options.dataRoot,
    providersConfigPath: options.modelAdapterProvidersConfigPath,
  });
  const systemConfig = new SystemConfigService({ dataRoot: options.dataRoot, configPath: options.systemConfigPath });
  const memoryConfig = systemConfig.getMemoryConfig();
  const mcp = new McpService({ dataRoot: options.dataRoot, configPath: options.mcpConfigPath });
  void mcp.autoConnectEnabledServers();
  agentConfig.setMcpService(mcp);
  const fileIndex = new FileIndexService({ dbPath: options.dbPath, dataRoot: options.dataRoot });

  const vectorStoreConfig = systemConfig.getVectorStoreConfig();
  const resolvedVectorStoreConfig =
    options.dbPath === ":memory:"
      ? { ...vectorStoreConfig, sqlite_vec: { ...vectorStoreConfig.sqlite_vec, database_path: ":memory:" } }
      : vectorStoreConfig;
  const vectorStore = createVectorStoreFromConfig(resolvedVectorStoreConfig, options.dataRoot);
  const documentExtractDispatcher = new DocumentExtractDispatcher(systemConfig.getDocumentExtractionConfig());
  const knowledgeBase = new KnowledgeBaseService(modelAdapter, {
    vectorStore,
    knowledgeConfig: vectorStore,
    knowledgeFileStore: vectorStore,
    documentExtractDispatcher,
    ...(options.embedderFactory ? { embedderFactory: options.embedderFactory } : {}),
  });
  const knowledge = options.knowledgeQueryFactory?.({ tenantId: options.tenantId, baseKnowledge: knowledgeBase })
    ?? new LocalKnowledgeQueryAdapter(knowledgeBase);
  const artifacts = new ArtifactService({ dataRoot: options.dataRoot });
  const embeddingModels = new EmbeddingModelService(knowledgeBase);
  const memoryStore = new MemoryStore({ dataRoot: options.dataRoot });
  const memoryBindings = options.memoryBindingsFactory?.({
    tenantId: options.tenantId,
    dataRoot,
    memoryConfig,
    memoryRepository: memoryStore,
    sessions: conversationStore,
  }) ?? {
    tools: new MemoryToolService(memoryStore, conversationStore, conversationStore, options.tenantId),
    createContextSource: (input) => new MemoryIndexContextSource(
      input.sessions,
      input.memory,
      input.agentName,
      {
        memoryRepository: memoryStore,
        indexMaxLines: input.memoryConfig.index_max_lines,
        indexMaxChars: input.memoryConfig.index_max_chars,
      },
    ),
  };
  const documentTools = new LocalDocumentToolService({ dataRoot: options.dataRoot, fileHistory });
  const notificationQueue = new SessionNotificationQueue();
  const backgroundTasks = new BackgroundTaskService({
    notificationQueue,
    ...(options.asyncBackgroundTasks ? { repository: options.asyncBackgroundTasks, tenantId: options.tenantId } : {}),
  });
  const toolsConfig = systemConfig.getToolsConfig();
  const codeExecutionTools = new CodeExecutionToolService({
    dataRoot: options.dataRoot,
    defaultTimeoutSeconds: toolsConfig.code_default_timeout,
    maxTimeoutSeconds: toolsConfig.code_max_timeout,
  });
  const skillTools = new SkillToolService({
    dataRoot: options.dataRoot,
    agentConfig,
    artifacts,
    backgroundTasks,
    clientEvents,
  });
  agentConfig.setSkillToolService(skillTools);
  const skillLibrary = new SkillLibraryService(skillTools);
  const searchTools = new LocalSearchToolService({ dataRoot: options.dataRoot });
  const bashTools = new LocalBashToolService({
    dataRoot: options.dataRoot,
    defaultTimeoutSeconds: toolsConfig.bash_default_timeout,
    maxTimeoutSeconds: toolsConfig.bash_max_timeout,
    maxOutputChars: toolsConfig.bash_max_output,
    backgroundTasks,
    clientEvents,
  });
  const taskTools = new TaskToolService(backgroundTasks, notificationQueue, { dataRoot: options.dataRoot });
  const pendingInteractions = new PendingInteractionService(clientEvents, conversationStore);
  const asyncSuspendedSessionControl = options.asyncSuspendedSessionControlFactory?.(options.tenantId);
  const hostToolRegistry = new HostToolRegistry();
  const delegationPending = new DelegationPendingService();

  return createCoreRuntimeContainer({
    tenantId: options.tenantId,
    dataRoot,
    memoryConfig,
    logger: options.logger,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.asyncEventPersisterFactory ? { asyncEventPersisterFactory: options.asyncEventPersisterFactory } : {}),
    ...(options.asyncConversationHistory ? { asyncConversationHistory: options.asyncConversationHistory } : {}),
    ...(options.asyncProviderContinuations ? { asyncProviderContinuations: options.asyncProviderContinuations } : {}),
    ...(asyncClientEvents ? { asyncClientEvents } : {}),
    ...(asyncSuspendedSessionControl ? { asyncSuspendedSessionControl } : {}),
    conversationStore,
    sessionApplication,
    realtimeEvents,
    permissionPolicy,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
    fileHistory,
    fileIndex,
    knowledgeBase,
    knowledge,
    artifacts,
    transientArtifacts,
    embeddingModels,
    memoryStore,
    memoryBindings,
    executionStorage: options.executionStorage
      ?? options.executionStorageFactory?.({ tenantId: options.tenantId, ...(asyncClientEvents ? { asyncClientEvents } : {}) })
      ?? createLocalExecutionStorage(conversationStore),
    documentTools,
    codeExecutionTools,
    skillTools,
    skillLibrary,
    searchTools,
    bashTools,
    backgroundTasks,
    taskTools,
    notificationQueue,
    pendingInteractions,
    hostToolRegistry,
    delegationPending,
    outboxDispatcher,
    clientEvents,
    closeInfrastructure: () => {
      backgroundTasks.dispose();
      transientArtifacts.stopPruning();
      outboxDispatcher.stop();
      mcp.close();
      knowledgeBase.close();
      fileIndex.close();
      conversationStore.close();
    },
  });
}
