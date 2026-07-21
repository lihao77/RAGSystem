import { AgentCompressionService } from "../agent/context-compression/compression-service.js";
import { AgentDelegationService } from "../agent/delegation/index.js";
import { createAgentExecutionService } from "../agent/execution/index.js";
import { createResumeExecutor } from "../agent/execution/resume-executor.js";
import { RuntimeCoreService } from "../agent/execution/runtime-core-service.js";
import { AgentMetricsCollector } from "../agent/metrics/metrics-collector.js";
import type {
  CoreRuntimeDependencies,
  LocalCoreRuntimeDependencies,
  LocalRuntimeContainer,
  RuntimeContainer,
  SaaSCoreRuntimeDependencies,
  SaaSRuntimeContainer,
} from "../../contracts/runtime/runtime-container.js";
import type { ClientEventPublisher } from "./event-outbox/client-event-publisher.js";
import { RuntimeInteractionCoordinator } from "./pending-interaction-service.js";
import { PermissionPolicyService } from "./permission-policy-service.js";

/** Assemble deployment-provided services into the shared agent runtime. */
export function createCoreRuntimeContainer(dependencies: LocalCoreRuntimeDependencies): LocalRuntimeContainer;
export function createCoreRuntimeContainer(dependencies: SaaSCoreRuntimeDependencies): SaaSRuntimeContainer;
export function createCoreRuntimeContainer(dependencies: CoreRuntimeDependencies): RuntimeContainer {
  const {
    deploymentKind,
    tenantId,
    dataRoot,
    getMemoryConfig,
    delegationStore,
    metricsStore,
    permissionPolicyStore,
    compressionHistory,
    executionSessions,
    sessionApplication,
    realtimeEvents,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
    sessionFiles,
    knowledge,
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
    hostToolRegistry,
    delegationPending,
    eventDispatcher,
    clientEvents,
  } = dependencies;

  // SaaS 的用户可见事件必须进入 PostgreSQL durable outbox；Local 继续使用 SQLite outbox。
  const eventClientEvents: ClientEventPublisher = dependencies.asyncClientEvents;
  const executionDispatcher = {
    dispatchRows: (rows: Parameters<typeof eventDispatcher.dispatchRows>[0]) => {
      const result = eventDispatcher.dispatchRows(rows);
      return Array.isArray(result) ? result : [];
    },
  };
  const interactionCoordinator = new RuntimeInteractionCoordinator(
    dependencies.runtimeStorage,
    dependencies.asyncClientEvents,
  );
  const selectedPendingInteractions = interactionCoordinator;

  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter);
  const agentDelegation = new AgentDelegationService(delegationStore, runtimeCore, eventClientEvents);
  const toolsDeps = {
    memoryTools: memoryBindings.tools,
    pendingInteractions: selectedPendingInteractions,
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
  const metricsCollector = new AgentMetricsCollector(metricsStore);
  const permissionPolicy = new PermissionPolicyService(permissionPolicyStore);
  const agentExecution = createAgentExecutionService({
    tenantId,
    sessions: executionSessions,
    executionStorage: dependencies.executionStorage,
    pathAccessPolicyFactory: dependencies.pathAccessPolicyFactory,
    runtimeCore,
    dataRoot,
    getMemoryConfig,
    memoryContextSourceFactory: memoryBindings.createContextSource,
    toolsDeps,
    codeExecutionTools,
    taskTools,
    providersProvider: () => modelAdapter.listProviders(),
    backgroundTasks,
    notificationQueue,
    ...(sessionFiles.kind === "local" ? { fileIndex: sessionFiles.fileIndex } : {}),
    ...(sessionFiles.kind === "async" ? { asyncSessionFiles: sessionFiles.storage } : {}),
    outboxDispatcher: executionDispatcher,
    clientEvents,
    eventClientEvents,
    permissionPolicy,
    pendingInteractions: selectedPendingInteractions,
    hostToolRegistry,
    delegationPending,
    logger: dependencies.logger,
    metricsCollector,
    ...(dependencies.asyncAnalytics ? { asyncAnalytics: dependencies.asyncAnalytics } : {}),
    compressionService: new AgentCompressionService(
      compressionHistory,
      () => modelAdapter.listProviders(),
      systemConfig,
      undefined,
      dependencies.asyncConversationHistory,
    ),
    ...(dependencies.hooks ? { hooks: dependencies.hooks } : {}),
    ...(dependencies.asyncClientEvents ? { asyncClientEvents: dependencies.asyncClientEvents } : {}),
    ...(dependencies.runtimeStorage ? { runtimeStorage: dependencies.runtimeStorage } : {}),
    ...(dependencies.asyncSuspendedSessionControl ? { asyncSuspendedSessionControl: dependencies.asyncSuspendedSessionControl } : {}),
  });
  const resumeExecutor = createResumeExecutor({
    runEngine: agentExecution.runEngine,
    runtimeCore,
  });
  interactionCoordinator.bindResumeStarter(resumeExecutor);
  agentDelegation.setRunEngine(() => agentExecution.runEngine);
  backgroundTasks.setOnTaskCompleted((sessionId) => agentExecution.triggerBgNotificationRun(sessionId));

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    dependencies.closeInfrastructure();
  };

  const common = {
    deploymentKind,
    tenantId,
    sessionApplication,
    realtimeEvents,
    agentExecution,
    metricsCollector,
    permissionPolicy,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
    knowledge,
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
    pendingInteractions: selectedPendingInteractions,
    interactionCoordinator,
    hostToolRegistry,
    delegationPending,
    toolsDeps,
    runtimeCore,
    agentDelegation,
    eventDispatcher,
    clientEvents,
    dataRoot,
    close,
  };
  return dependencies.deploymentKind === "local"
    ? { ...common, deploymentKind: "local", local: dependencies.capabilities, saas: null }
    : { ...common, deploymentKind: "saas", local: null, saas: dependencies.capabilities };
}
