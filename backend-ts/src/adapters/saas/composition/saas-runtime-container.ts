import path from "node:path";

import type { HookRegistry } from "@ragsystem/agent-sdk";

import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import type { IFileHistoryStore } from "../../../contracts/file-history-store/index.js";
import type { IFileIndexStore } from "../../../contracts/file-index-store/index.js";
import type { IMemoryStore } from "../../../contracts/memory-store/index.js";
import type { RuntimeContainer } from "../../../contracts/runtime/runtime-container.js";
import type { TenantId } from "../../../identity/types.js";
import { AgentConfigService } from "../../../services/agent/config/index.js";
import type { AgentExecutionLogger } from "../../../services/agent/execution/index.js";
import { AsyncKernelEventPersister } from "../../../services/agent/sdk/async-event-persister.js";
import type { ArtifactService } from "../../../services/artifacts/artifact-service.js";
import type { TransientArtifactService } from "../../../services/artifacts/transient-artifact-service.js";
import { SystemConfigService } from "../../../services/config/system-config-service.js";
import { McpService } from "../../../services/integrations/mcp-service.js";
import { ModelAdapterService } from "../../../services/integrations/model-adapter-service.js";
import { EmbeddingModelService } from "../../../services/knowledge/embedding-model-service.js";
import type { KnowledgeBaseService } from "../../../services/knowledge/knowledge-base-service.js";
import { BackgroundTaskService } from "../../../services/runtime/background-task-service.js";
import { createCoreRuntimeContainer } from "../../../services/runtime/core-runtime-container.js";
import { DelegationPendingService } from "../../../services/runtime/delegation-pending-service.js";
import { AsyncDurableClientEventPublisher } from "../../../services/runtime/event-outbox/async-client-event-publisher.js";
import { AsyncOutboxDispatcher } from "../../../services/runtime/event-outbox/async-dispatcher.js";
import type { DurableClientEventPublisher } from "../../../services/runtime/event-outbox/client-event-publisher.js";
import type { OutboxDispatcher } from "../../../services/runtime/event-outbox/dispatcher.js";
import { HostToolRegistry } from "../../../services/runtime/host-tool-registry.js";
import { PathApprovalService } from "../../../services/runtime/path-approval-service.js";
import { RealtimeEventHub } from "../../../services/runtime/realtime-event-hub.js";
import { SessionNotificationQueue } from "../../../services/runtime/session-notification-queue.js";
import type { AgentSessionApplication } from "../../../services/sessions/index.js";
import { SkillLibraryService } from "../../../services/skills/skill-library-service.js";
import { SkillToolService } from "../../../tools/SkillTools/SkillExecution.js";
import { TaskToolService } from "../../../tools/TaskTools/TaskExecution.js";
import { SaaSSessionApplication } from "../application/session/saas-session-application.js";
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
export function createSaaSRuntimeContainer(options: SaaSRuntimeContainerOptions): RuntimeContainer {
  const { tenantId, conversationRuntime, memoryRuntime } = options;
  const dataRoot = path.resolve(options.dataRoot);
  const runtimeStorage = conversationRuntime.createRuntimeStorage(tenantId);
  const realtimeEvents = new RealtimeEventHub();
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
  const sessionApplication = new SaaSSessionApplication(
    tenantId,
    conversationRuntime.conversation,
    fileHistory,
    conversationRuntime.runs,
    conversationRuntime.outbox,
  );

  const agentConfig = new AgentConfigService({ dataRoot, configRoot: options.agentConfigRoot });
  const modelAdapter = new ModelAdapterService({
    dataRoot,
    providersConfigPath: options.modelAdapterProvidersConfigPath,
  });
  const systemConfig = new SystemConfigService({ dataRoot, configPath: options.systemConfigPath });
  const mcp = new McpService({ dataRoot, configPath: options.mcpConfigPath });
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
  const knowledgeBase = knowledge as unknown as KnowledgeBaseService;
  const embeddingModels = new EmbeddingModelService(knowledgeBase);
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
    conversationStore: null as unknown as ConversationStore,
    delegationStore: conversationRuntime.createDelegationStore(tenantId),
    metricsStore: new SaaSAgentMetricsStore(tenantId, conversationRuntime.analytics),
    permissionPolicyStore,
    compressionHistory: null,
    sessionApplication: sessionApplication as unknown as AgentSessionApplication,
    realtimeEvents,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
    fileHistory: null as unknown as IFileHistoryStore,
    fileIndex: null as unknown as IFileIndexStore,
    asyncSessionFiles: sessionFiles,
    knowledgeBase,
    knowledge,
    artifacts: null as unknown as ArtifactService,
    transientArtifacts: null as unknown as TransientArtifactService,
    embeddingModels,
    memoryStore: memoryRuntime.repository as unknown as IMemoryStore,
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
    outboxDispatcher: asyncOutboxDispatcher as unknown as OutboxDispatcher,
    clientEvents: asyncClientEvents as unknown as DurableClientEventPublisher,
    closeInfrastructure: () => {
      backgroundTasks.dispose();
      asyncOutboxDispatcher.stop();
      mcp.close();
    },
  });
}

/** Refresh tenant-scoped provider configuration before a leased runtime is used. */
export async function prepareSaaSRuntimeContainer(
  tenantId: TenantId,
  runtime: RuntimeContainer,
  conversationRuntime: SaaSConversationRuntimeHandle,
): Promise<void> {
  runtime.modelAdapter.replaceRuntimeProviders(
    await conversationRuntime.providerMcpApplication.listProviders(tenantId),
  );
}
