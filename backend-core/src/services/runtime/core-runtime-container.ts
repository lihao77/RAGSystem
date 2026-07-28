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
import { RuntimeInteractionCoordinator } from "./pending-interaction-service.js";
import { PermissionPolicyService } from "./permission-policy-service.js";
import { CapabilityRegistry } from "../../plugins/capability-registry.js";

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
    memoryBindings,
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
    eventDispatcher,
    clientEvents,
  } = dependencies;
  const pluginCapabilities = dependencies.pluginCapabilities ?? new CapabilityRegistry();

  const interactionCoordinator = new RuntimeInteractionCoordinator(
    dependencies.runtimeStorage,
    clientEvents,
  );
  const selectedPendingInteractions = interactionCoordinator;

  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter);
  const agentDelegation = new AgentDelegationService(delegationStore, runtimeCore, clientEvents);
  const toolsDeps = {
    memoryTools: memoryBindings.tools,
    pendingInteractions: selectedPendingInteractions,
    documentTools,
    bashTools,
    taskTools,
    searchTools,
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
    goalStore,
    providersProvider: () => modelAdapter.listProviders(),
    backgroundTasks,
    notificationQueue,
    sessionFiles,
    outboxDispatcher: eventDispatcher,
    clientEvents,
    permissionPolicy,
    pendingInteractions: selectedPendingInteractions,
    hostToolRegistry,
    delegationPending,
    logger: dependencies.logger,
    metricsCollector,
    compressionService: new AgentCompressionService(
      compressionHistory,
      () => modelAdapter.listProviders(),
      systemConfig,
    ),
    ...((dependencies.hooks || dependencies.plugins) ? {
      hooks: (registry) => {
        dependencies.hooks?.(registry);
        dependencies.plugins?.configureHooks(registry);
      },
    } : {}),
    ...(dependencies.plugins ? {
      pluginTools: (context: import("../../plugins/backend-plugin.js").BackendToolFactoryContext) =>
        dependencies.plugins!.createTools({ ...context, capabilities: pluginCapabilities }),
    } : {}),
    runtimeStorage: dependencies.runtimeStorage,
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
    pluginCapabilities,
    sessionApplication,
    realtimeEvents,
    sessionFiles,
    agentExecution,
    metricsCollector,
    permissionPolicy,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
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
    goalStore,
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
