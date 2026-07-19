import type { MemoryRepository } from "../../contracts/memory-store/index.js";
import { AgentCompressionService } from "../agent/context-compression/compression-service.js";
import { AgentDelegationService } from "../agent/delegation/index.js";
import { createAgentExecutionService } from "../agent/execution/index.js";
import { createResumeExecutor } from "../agent/execution/resume-executor.js";
import { RuntimeCoreService } from "../agent/execution/runtime-core-service.js";
import { AgentMetricsCollector } from "../agent/metrics/metrics-collector.js";
import type { CoreRuntimeDependencies, RuntimeContainer } from "../../contracts/runtime-container.js";

/** Assemble deployment-provided services into the shared agent runtime. */
export function createCoreRuntimeContainer<TMemoryRepository extends MemoryRepository>(
  dependencies: CoreRuntimeDependencies<TMemoryRepository>,
): RuntimeContainer<TMemoryRepository> {
  const {
    tenantId,
    dataRoot,
    memoryConfig,
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
  } = dependencies;

  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter);
  const agentDelegation = new AgentDelegationService(conversationStore, runtimeCore, clientEvents);
  const toolsDeps = {
    memoryTools: memoryBindings.tools,
    pendingInteractions,
    documentTools,
    bashTools,
    taskTools,
    searchTools,
    knowledge,
    mcp,
    codeExecutionTools,
    skillTools,
    getAgentDelegation: () => agentDelegation,
    agentConfig,
  };
  const metricsCollector = new AgentMetricsCollector(conversationStore);
  const agentExecution = createAgentExecutionService({
    tenantId,
    sessions: sessionApplication,
    conversationStore,
    executionStorage: dependencies.executionStorage,
    pathAccessPolicyFactory: dependencies.pathAccessPolicyFactory,
    runtimeCore,
    dataRoot,
    memoryConfig,
    memoryContextSourceFactory: memoryBindings.createContextSource,
    toolsDeps,
    codeExecutionTools,
    taskTools,
    providersProvider: () => modelAdapter.listProviders(),
    backgroundTasks,
    notificationQueue,
    fileIndex,
    outboxDispatcher,
    clientEvents,
    permissionPolicy,
    pendingInteractions,
    hostToolRegistry,
    delegationPending,
    logger: dependencies.logger,
    metricsCollector,
    compressionService: new AgentCompressionService(
      conversationStore,
      () => modelAdapter.listProviders(),
      systemConfig,
      undefined,
      dependencies.asyncConversationHistory,
    ),
    ...(dependencies.hooks ? { hooks: dependencies.hooks } : {}),
    ...(dependencies.asyncClientEvents ? { asyncClientEvents: dependencies.asyncClientEvents } : {}),
    ...(dependencies.asyncSuspendedSessionControl ? { asyncSuspendedSessionControl: dependencies.asyncSuspendedSessionControl } : {}),
  });
  const resumeExecutor = createResumeExecutor({
    runEngine: agentExecution.runEngine,
    conversationStore,
    pendingInteractions,
    runtimeCore,
  });
  agentDelegation.setRunEngine(() => agentExecution.runEngine);
  backgroundTasks.setOnTaskCompleted((sessionId) => agentExecution.triggerBgNotificationRun(sessionId));

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    dependencies.closeInfrastructure();
  };

  return {
    conversationStore,
    sessionApplication,
    realtimeEvents,
    agentExecution,
    resumeExecutor,
    metricsCollector,
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
    memoryTools: memoryBindings.tools,
    memoryContextSourceFactory: memoryBindings.createContextSource,
    documentTools,
    codeExecutionTools,
    skillTools,
    skillLibrary,
    searchTools,
    bashTools,
    backgroundTasks,
    taskTools,
    pendingInteractions,
    hostToolRegistry,
    delegationPending,
    toolsDeps,
    runtimeCore,
    agentDelegation,
    outboxDispatcher,
    clientEvents,
    dataRoot,
    close,
  };
}
