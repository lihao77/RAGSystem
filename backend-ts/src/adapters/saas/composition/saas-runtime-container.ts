import path from "node:path";

import type { HookRegistry } from "@ragsystem/agent-sdk";

import type { RuntimeContainer, SaaSRuntimeContainer } from "../../../contracts/runtime/runtime-container.js";
import type { TenantId } from "../../../identity/types.js";
import { AgentConfigService } from "../../../services/agent/config/index.js";
import type { AgentExecutionLogger } from "../../../services/agent/execution/index.js";
import { AsyncKernelEventPersister } from "../../../services/agent/sdk/async-event-persister.js";
import { SystemConfigService } from "../../../services/config/system-config-service.js";
import { ModelAdapterService } from "../../../services/integrations/model-adapter-service.js";
import { BackgroundTaskService } from "../../../services/runtime/background-task-service.js";
import { createCoreRuntimeContainer } from "../../../services/runtime/core-runtime-container.js";
import { DelegationPendingService } from "../../../services/runtime/delegation-pending-service.js";
import { AsyncDurableClientEventPublisher } from "../../../services/runtime/event-outbox/async-client-event-publisher.js";
import { AsyncOutboxDispatcher } from "../../../services/runtime/event-outbox/async-dispatcher.js";
import { HostToolRegistry } from "../../../services/runtime/host-tool-registry.js";
import { PathApprovalService } from "../../../services/runtime/path-approval-service.js";
import { SessionNotificationQueue } from "../../../services/runtime/session-notification-queue.js";
import { SkillLibraryService } from "../../../services/skills/skill-library-service.js";
import { SkillToolService } from "../../../tools/SkillTools/SkillExecution.js";
import { TaskToolService } from "../../../tools/TaskTools/TaskExecution.js";
import { SaaSSessionApplication } from "../application/session/saas-session-application.js";
import { SaaSExecutionMemoryCandidates } from "../application/memory/saas-execution-memory-candidates.js";
import { SaaSAgentMetricsStore } from "../postgres/saas-agent-metrics-store.js";
import { SaaSPermissionPolicyStore } from "../postgres/saas-permission-policy-store.js";
import { createPostgresExecutionStorage } from "../postgres/postgres-execution-storage.js";
import type { SaaSConversationRuntimeHandle } from "./saas-conversation-runtime.js";
import type { SaaSMemoryRuntimeHandle } from "./saas-memory-runtime.js";

export interface SaaSRuntimeContainerOptions {
  tenantId: TenantId;
  dataRoot: string;
  conversationRuntime: SaaSConversationRuntimeHandle;
  memoryRuntime: SaaSMemoryRuntimeHandle;
  logger?: AgentExecutionLogger;
  hooks?: (registry: HookRegistry) => void;
  modelAdapterProvidersConfigPath?: string;
  mcpConfigPath?: string;
  systemConfigPath?: string;
  agentConfigRoot?: string;
}

/** Assemble a tenant runtime without constructing any Local or SQLite adapter. */
export async function createSaaSRuntimeContainer(options: SaaSRuntimeContainerOptions): Promise<SaaSRuntimeContainer> {
  const { tenantId, conversationRuntime, memoryRuntime } = options;
  const dataRoot = path.resolve(options.dataRoot);
  const runtimeStorage = conversationRuntime.createRuntimeStorage(tenantId);
  const realtimeEvents = conversationRuntime.createRealtimeEventBus(tenantId);
  const asyncOutboxDispatcher = new AsyncOutboxDispatcher(
    conversationRuntime.outbox,
    realtimeEvents,
    undefined,
    { tenantId },
  );
  asyncOutboxDispatcher.start();
  const asyncClientEvents = new AsyncDurableClientEventPublisher(runtimeStorage, asyncOutboxDispatcher);
  const fileHistory = conversationRuntime.createFileHistoryStorage(tenantId);
  const sessionFiles = conversationRuntime.createSessionFileStorage(tenantId);
  const memoryCandidates = new SaaSExecutionMemoryCandidates(tenantId, memoryRuntime.repository);
  const sessionApplication = new SaaSSessionApplication(
    tenantId,
    conversationRuntime.conversation,
    fileHistory,
    conversationRuntime.runs,
    conversationRuntime.outbox,
    memoryCandidates,
  );

  const agentConfig = new AgentConfigService({ dataRoot, configRoot: options.agentConfigRoot });
  const modelAdapter = new ModelAdapterService({
    dataRoot,
    providersConfigPath: options.modelAdapterProvidersConfigPath,
  });
  const systemConfig = new SystemConfigService({ dataRoot, configPath: options.systemConfigPath });
  const mcp = await conversationRuntime.providerMcpApplication.resolveMcpRuntime(tenantId);
  void mcp.autoConnectEnabledServers();
  agentConfig.setMcpService(mcp);

  const notificationQueue = new SessionNotificationQueue();
  const backgroundTasks = new BackgroundTaskService({
    notificationQueue,
    repository: conversationRuntime.backgroundTasks,
    tenantId,
  });
  const skillTools = new SkillToolService({
    dataRoot,
    agentConfig,
    backgroundTasks,
    clientEvents: asyncClientEvents,
  });
  agentConfig.setSkillToolService(skillTools);
  const skillLibrary = new SkillLibraryService(skillTools);
  const taskTools = new TaskToolService(backgroundTasks, notificationQueue, { dataRoot });
  const memoryBindings = memoryRuntime.provider.createMemoryBindings(
    tenantId,
    sessionApplication,
  );
  const knowledge = conversationRuntime.createKnowledgeService(tenantId, modelAdapter);
  const artifacts = conversationRuntime.createArtifactService(tenantId);
  const memory = memoryRuntime.provider.memoryForTenant(tenantId);
  const permissionPolicyStore = new SaaSPermissionPolicyStore(tenantId, conversationRuntime.conversation);

  return createCoreRuntimeContainer({
    deploymentKind: "saas",
    tenantId,
    dataRoot,
    memoryConfig: systemConfig.getMemoryConfig(),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    asyncConversationHistory: conversationRuntime.conversation,
    asyncProviderContinuations: conversationRuntime.providerContinuations,
    asyncClientEvents,
    runtimeStorage,
    delegationStore: conversationRuntime.createDelegationStore(tenantId),
    metricsStore: new SaaSAgentMetricsStore(tenantId, conversationRuntime.analytics),
    permissionPolicyStore,
    compressionHistory: null,
    executionSessions: sessionApplication,
    sessionApplication,
    realtimeEvents,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
    sessionFiles: { kind: "async", storage: sessionFiles },
    knowledge,
    memoryBindings,
    executionStorage: createPostgresExecutionStorage({
      tenantId,
      conversation: conversationRuntime.conversation,
      providerContinuations: conversationRuntime.providerContinuations,
      clientEvents: asyncClientEvents,
      createEventPersister: (context) => new AsyncKernelEventPersister(
        runtimeStorage,
        asyncClientEvents,
        context,
        fileHistory,
      ),
      resultReader: {
        getRun: (sessionId, runId) => conversationRuntime.runs.getRun(tenantId, sessionId, runId),
        getMessageById: (sessionId, messageId) => conversationRuntime.conversation.getMessageById(sessionId, messageId),
        listRunSteps: (input) => conversationRuntime.runs.listRunSteps({ tenantId, ...input }),
      },
      memoryCandidates,
    }),
    pathAccessPolicyFactory: () => new PathApprovalService(),
    documentTools: null,
    codeExecutionTools: null,
    skillTools,
    skillLibrary,
    searchTools: null,
    bashTools: null,
    backgroundTasks,
    taskTools,
    notificationQueue,
    hostToolRegistry: new HostToolRegistry(),
    delegationPending: new DelegationPendingService(),
    eventDispatcher: asyncOutboxDispatcher,
    clientEvents: asyncClientEvents,
    capabilities: {
      sessions: sessionApplication,
      fileHistory,
      sessionFiles,
      artifacts,
      memory,
    },
    closeInfrastructure: () => {
      backgroundTasks.dispose();
      asyncOutboxDispatcher.stop();
      realtimeEvents.close();
      // The tenant MCP runtime is owned by the shared PostgreSQL config registry.
    },
  });
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
    await conversationRuntime.providerMcpApplication.listProviders(tenantId),
  );
  const mcp = await conversationRuntime.providerMcpApplication.resolveMcpRuntime?.(tenantId);
  if (mcp && mcp !== runtime.mcp) throw new Error("SaaS MCP runtime identity changed while the tenant runtime was leased");
}
