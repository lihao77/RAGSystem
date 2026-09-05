import { AgentCompressionService } from "../agent/context-compression/compression-service.js";
import { AgentDelegationService } from "../agent/delegation/index.js";
import { createAgentExecutionService } from "../agent/execution/index.js";
import { createResumeExecutor } from "../agent/execution/resume-executor.js";
import { readSessionRequestOverrides } from "../agent/execution/session-request-overrides.js";
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
import { SessionRuntimeService } from "./session-runtime-service.js";
import {
  EXECUTION_ENVIRONMENT_CAPABILITY,
  type ExecutionEnvironmentCapability,
} from "../../contracts/execution/execution-environment.js";

/** Assemble deployment-provided services into the shared agent runtime. */
export function createCoreRuntimeContainer(dependencies: LocalCoreRuntimeDependencies): LocalRuntimeContainer;
export function createCoreRuntimeContainer(dependencies: SaaSCoreRuntimeDependencies): SaaSRuntimeContainer;
export function createCoreRuntimeContainer(dependencies: CoreRuntimeDependencies): RuntimeContainer {
  const {
    deploymentKind,
    tenantId,
    dataRoot,
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
    sessionFiles,
    backgroundTasks,
    taskTools,
    goalStore,
    hostToolRegistry,
    delegationPending,
    eventDispatcher,
    clientEvents,
  } = dependencies;
  const pluginCapabilities = dependencies.pluginCapabilities ?? new CapabilityRegistry();
  const executionEnvironment = pluginCapabilities.get(EXECUTION_ENVIRONMENT_CAPABILITY);
  if (!executionEnvironment) {
    throw new Error(`${deploymentKind} deployment must provide an execution environment capability`);
  }
  const createPluginTools = (context: import("../../plugins/backend-plugin.js").BackendToolFactoryContext) =>
    dependencies.plugins?.createTools({ ...context, capabilities: pluginCapabilities }) ?? Promise.resolve([]);
  const listPluginTools = () => dependencies.plugins?.listTools() ?? [];

  const interactionCoordinator = new RuntimeInteractionCoordinator(
    dependencies.runtimeStorage,
    clientEvents,
  );
  const selectedPendingInteractions = interactionCoordinator;
  const sessionRuntime = new SessionRuntimeService(dependencies.runtimeStorage);

  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter, systemConfig);
  const agentDelegation = new AgentDelegationService(
    delegationStore,
    runtimeCore,
    clientEvents,
    backgroundTasks,
    dataRoot,
    dependencies.executionStorage?.agentMailbox ?? null,
    dependencies.logger ?? null,
    tenantId,
  );
  const toolsDeps = {
    pendingInteractions: selectedPendingInteractions,
    taskTools,
    getAgentDelegation: () => agentDelegation,
    agentConfig,
  };
  const metricsCollector = new AgentMetricsCollector(metricsStore);
  const permissionPolicy = new PermissionPolicyService(permissionPolicyStore);
  // 前置 context source 工厂只聚合一次：run 引擎与容器暴露（monitoring 预览）共用同一份。
  const contextSourceFactories = dependencies.pluginRuntime?.contextSources ?? null;
  const agentExecution = createAgentExecutionService({
    tenantId,
    sessions: executionSessions,
    executionStorage: dependencies.executionStorage,
    pathAccessPolicyFactory: dependencies.pathAccessPolicyFactory,
    runtimeCore,
    dataRoot,
    toolsDeps,
    taskTools,
    goalStore,
    providersProvider: () => modelAdapter.listProviders(),
    backgroundTasks,
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
      dependencies.logger ?? null,
    ),
    ...((dependencies.hooks || dependencies.plugins) ? {
      hooks: (registry) => {
        dependencies.hooks?.(registry);
        dependencies.plugins?.configureHooks(registry);
        dependencies.pluginRuntime?.configureHooks(registry);
      },
    } : {}),
    ...(dependencies.plugins ? {
      pluginTools: createPluginTools,
      // 用户消息持久化前变换：注入 readAttachment（会话文件字节读取）、modelAdapter 与
      // systemConfig（插件视觉模型查询与配置读取；transformer 每次执行实时读配置）；
      // clientEvents 供宿主按插件构建 pluginEvents（变换进度推 plugin_event 帧）。
      userMessageTransformers: async (input) =>
        dependencies.plugins?.transformUserMessage({
          ...input,
          modelAdapter,
          systemConfig,
          clientEvents,
          readAttachment: async (fileId) => {
            const record = sessionFiles ? await sessionFiles.read(input.sessionId, fileId) : null;
            return record?.body ?? null;
          },
        }) ?? null,
    } : {}),
    runtimeStorage: dependencies.runtimeStorage,
    executionEnvironment,
    participantRuns: agentDelegation,
    systemConfig,
    contextSourceFactories,
  });
  const resumeExecutor = createResumeExecutor({
    invocationService: agentExecution.invocationService,
    runtimeCore,
    participantRuns: agentDelegation,
    completeAgentMailboxContinuation: agentExecution.completeAgentMailboxContinuation,
    // 挂起恢复读会话级设定（模型/思考档位），与用户发起时的执行口径保持一致。
    readSessionRequestOverrides: async (sessionId) => {
      const session = await executionSessions.getSession(sessionId);
      return readSessionRequestOverrides(session?.metadata);
    },
  });
  interactionCoordinator.bindResumeStarter(resumeExecutor);
  agentDelegation.setInvocationService(agentExecution.invocationService);
  agentDelegation.setLocalRunCanceller((runId, reason) => agentExecution.cancelRun(runId, reason));
  agentDelegation.setMailboxWakeup((target) => agentExecution.triggerAgentMailboxRun(target));
  backgroundTasks.setOnTaskRecovered((task) => agentDelegation.recoverBackgroundTask(task));
  backgroundTasks.setOnTaskCompleted((sessionId) => agentExecution.triggerBgNotificationRun(sessionId));
  // 后台完成通知的持久投递目标：与会话 mailbox 同库（容器口径 tenant），idle 检查
  // 与活动 run refresh 共用同一队列。
  backgroundTasks.setAgentMailbox(dependencies.executionStorage?.agentMailbox ?? null, tenantId);

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = Promise.resolve().then(() => dependencies.closeInfrastructure());
    return closePromise;
  };

  const common = {
    deploymentKind,
    tenantId,
    pluginCapabilities,
    createPluginTools,
    listPluginTools,
    contextSourceFactories,
    sessionApplication,
    realtimeEvents,
    sessionFiles,
    agentExecution,
    metricsCollector,
    permissionPolicy,
    agentConfig,
    modelAdapter,
    systemConfig,
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
    sessionRuntime,
    dataRoot,
    close,
  };
  return dependencies.deploymentKind === "local"
    ? { ...common, deploymentKind: "local", local: dependencies.capabilities, saas: null }
    : { ...common, deploymentKind: "saas", local: null, saas: dependencies.capabilities };
}
