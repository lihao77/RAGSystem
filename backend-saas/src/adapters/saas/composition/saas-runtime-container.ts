import path from "node:path";

import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { BackendRuntimeContributions } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { CapabilityRegistry, provideCapability, type CapabilityProvider } from "@ragsystem/backend-core/plugins/capability-registry.js";
import {
  KNOWLEDGE_APPLICATION_CAPABILITY,
  KNOWLEDGE_PLUGIN_ID,
  createPostgresKnowledgeApplication,
} from "@ragsystem/backend-plugin-knowledge/index.js";

import type { RuntimeContainer, SaaSRuntimeContainer } from "@ragsystem/backend-core/contracts/runtime/runtime-container.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";
import type { AgentExecutionLogger } from "@ragsystem/backend-core/services/agent/execution/index.js";
import { AsyncKernelEventPersister } from "@ragsystem/backend-core/services/agent/sdk/async-event-persister.js";
import { SystemConfigService } from "@ragsystem/backend-core/services/config/system-config-service.js";
// system config store is created via conversationRuntime (Postgres sole source of truth)
import { ModelAdapterService } from "@ragsystem/backend-core/services/integrations/model-adapter-service.js";
import { BackgroundTaskService } from "@ragsystem/backend-core/services/runtime/background-task-service.js";
import { createCoreRuntimeContainer } from "@ragsystem/backend-core/services/runtime/core-runtime-container.js";
import { DelegationPendingService } from "@ragsystem/backend-core/services/runtime/delegation-pending-service.js";
import { DurableClientEventPublisher } from "@ragsystem/backend-core/services/runtime/event-outbox/client-event-publisher.js";
import { HostToolRegistry } from "@ragsystem/backend-core/services/runtime/host-tool-registry.js";
import { PathApprovalService } from "@ragsystem/backend-core/services/runtime/path-approval-service.js";
import { SessionNotificationQueue } from "@ragsystem/backend-core/services/runtime/session-notification-queue.js";
import { SkillLibraryService } from "@ragsystem/backend-core/services/skills/skill-library-service.js";
import { SkillToolService } from "@ragsystem/backend-core/tools/SkillTools/SkillExecution.js";
import { TaskToolService } from "@ragsystem/backend-core/tools/TaskTools/TaskExecution.js";
import { SaaSSessionApplication } from "../application/session/saas-session-application.js";
import { SaaSExecutionMemoryCandidates } from "../application/memory/saas-execution-memory-candidates.js";
import { SaaSAgentMetricsStore } from "../postgres/saas-agent-metrics-store.js";
import { SaaSPermissionPolicyStore } from "../postgres/saas-permission-policy-store.js";
import { createPostgresExecutionStorage } from "../postgres/postgres-execution-storage.js";
import type { SaaSConversationRuntimeHandle } from "./saas-conversation-runtime.js";
import type { SaaSMemoryRuntimeHandle } from "./saas-memory-runtime.js";
import type { SandboxProvider } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import { SaaSSandboxFileBridge } from "../sandbox/sandbox-file-bridge.js";
import { SandboxLeaseManager } from "../sandbox/sandbox-lease-manager.js";
import {
  SaaSSandboxBashToolService,
  SaaSSandboxCodeExecutionService,
  SaaSSandboxDocumentToolService,
  SaaSSandboxSearchToolService,
} from "../sandbox/sandbox-tool-services.js";
export interface SaaSRuntimeContainerOptions {
  tenantId: TenantId;
  dataRoot: string;
  conversationRuntime: SaaSConversationRuntimeHandle;
  memoryRuntime: SaaSMemoryRuntimeHandle;
  logger?: AgentExecutionLogger;
  hooks?: (registry: HookRegistry) => void;
  plugins?: BackendRuntimeContributions;
  modelAdapterProvidersConfigPath?: string;
  mcpConfigPath?: string;
  sandboxProvider?: SandboxProvider;
  sandboxLeaseTimeoutSeconds?: number;
}

/** Assemble a tenant runtime without constructing any Local or SQLite adapter. */
export async function createSaaSRuntimeContainer(options: SaaSRuntimeContainerOptions): Promise<SaaSRuntimeContainer> {
  const { tenantId, conversationRuntime, memoryRuntime } = options;
  const dataRoot = path.resolve(options.dataRoot);
  const runtimeStorage = conversationRuntime.createRuntimeStorage(tenantId);
  const realtimeEvents = conversationRuntime.createRealtimeEventBus(tenantId);
  // Fast-path publisher: claim+deliver newly written rows via the shared process dispatcher.
  // Recovery polling is owned by conversationRuntime.sharedOutboxDispatcher (one per process).
  const outboxDispatcher = conversationRuntime.sharedOutboxDispatcher;
  const clientEvents = new DurableClientEventPublisher(runtimeStorage, outboxDispatcher);
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
    conversationRuntime.workspaces,
  );

  const agentConfig = new AgentConfigService(conversationRuntime.createAgentConfigTeamStore(tenantId));
  await agentConfig.initialize();
  // SaaS providers are Postgres-backed; ModelAdapterService is a pure in-process projection.
  // Force memory-only (empty path) so create/update never write providers.yaml under dataRoot.
  const modelAdapter = new ModelAdapterService({
    providersConfigPath: options.modelAdapterProvidersConfigPath ?? "",
  });
  // SaaS system config is Postgres-backed; SystemConfigService is an in-process projection.
  const systemConfig = new SystemConfigService(
    conversationRuntime.createSystemConfigStore(tenantId),
  );
  await systemConfig.initialize();
  const mcp = await conversationRuntime.providerMcpApplication.resolveMcpRuntime(tenantId);
  // Prime MCP status once per tenant runtime without delaying the HTTP request
  // that caused the runtime to be created. Session WebSocket setup performs an
  // idempotent confirmation before the agent starts using MCP tools.
  void mcp.autoConnectEnabledServers();
  agentConfig.setMcpService(mcp);

  const notificationQueue = new SessionNotificationQueue();
  const backgroundTasks = new BackgroundTaskService({
    notificationQueue,
    repository: conversationRuntime.backgroundTasks,
    tenantId,
    clientEvents,
  });
  // SaaS user_global cache is content-addressed under skill-cache/by-hash/<hash>/; durable SoT is PG + object storage.
  const skillCacheRoot = path.join(dataRoot, "skill-cache");
  const skillPackageStore = conversationRuntime.createSkillPackageStore(tenantId, skillCacheRoot);
  const skillTools = new SkillToolService({
    dataRoot,
    userGlobalSkillsRoot: skillCacheRoot,
    agentConfig,
    backgroundTasks,
    clientEvents,
    packageStore: skillPackageStore,
    ...(options.plugins?.skillSources.length ? {
      additionalBuiltinSkillSources: options.plugins.skillSources.map((source) => ({
        root: source.root,
        sourceLabel: source.pluginId,
      })),
    } : {}),
  });
  agentConfig.setSkillToolService(skillTools);
  const skillLibrary = new SkillLibraryService(skillTools, skillPackageStore);
  const goalStore = conversationRuntime.createGoalStore(tenantId);
  const taskTools = new TaskToolService(
    backgroundTasks,
    notificationQueue,
    goalStore,
  );
  const memoryBindings = memoryRuntime.provider.createMemoryBindings(
    tenantId,
    sessionApplication,
  );
  const pluginCapabilityProviders: CapabilityProvider[] = [];
  if (options.plugins?.isInstalled(KNOWLEDGE_PLUGIN_ID) ?? true) {
    const resources = conversationRuntime.pluginResources;
    if (!resources.objects) throw new Error("Knowledge plugin requires SaaS object storage");
    const knowledgeApplication = createPostgresKnowledgeApplication({
      tenantId,
      executor: resources.database,
      objects: resources.objects,
      modelAdapter,
      documentExtraction: systemConfig.getDocumentExtractionConfig(),
    });
    pluginCapabilityProviders.push(
      provideCapability(KNOWLEDGE_APPLICATION_CAPABILITY, knowledgeApplication, KNOWLEDGE_PLUGIN_ID),
    );
  }
  const pluginCapabilities = new CapabilityRegistry(pluginCapabilityProviders);
  const memory = memoryRuntime.provider.memoryForTenant(tenantId);
  const permissionPolicyStore = new SaaSPermissionPolicyStore(tenantId, conversationRuntime.conversation);
  const sandboxFileBridge = options.sandboxProvider ? new SaaSSandboxFileBridge(sessionFiles) : null;
  const sandboxLeases = options.sandboxProvider
    ? new SandboxLeaseManager(tenantId, options.sandboxProvider, options.sandboxLeaseTimeoutSeconds, sandboxFileBridge ?? undefined)
    : null;
  const documentTools = sandboxLeases ? new SaaSSandboxDocumentToolService(sandboxLeases) : null;
  const searchTools = sandboxLeases ? new SaaSSandboxSearchToolService(sandboxLeases) : null;
  const bashTools = sandboxLeases ? new SaaSSandboxBashToolService(sandboxLeases) : null;
  const codeExecutionTools = sandboxLeases ? new SaaSSandboxCodeExecutionService(sandboxLeases) : null;

  return createCoreRuntimeContainer({
    deploymentKind: "saas",
    tenantId,
    pluginCapabilities,
    dataRoot,
    getMemoryConfig: () => systemConfig.getMemoryConfig(),
    ...(options.logger ? { logger: options.logger } : {}),
    ...((options.hooks || sandboxLeases) ? { hooks: (registry: HookRegistry) => {
      options.hooks?.(registry);
      if (sandboxLeases) {
        registry.on("run.after", async ({ session }) => {
          try {
            await sandboxLeases.releaseRun(session.sessionId, session.runId);
          } catch (error) {
            options.logger?.error({
              tenantId,
              sessionId: session.sessionId,
              runId: session.runId,
              error: error instanceof Error ? error.message : String(error),
            }, "Sandbox output collection or cleanup failed");
            throw error;
          }
        });
      }
    } } : {}),
    ...(options.plugins ? { plugins: options.plugins } : {}),
    clientEvents,
    runtimeStorage,
    delegationStore: conversationRuntime.createDelegationStore(tenantId),
    metricsStore: new SaaSAgentMetricsStore(tenantId, conversationRuntime.analytics),
    permissionPolicyStore,
    compressionHistory: conversationRuntime.conversation,
    executionSessions: sessionApplication,
    sessionApplication,
    realtimeEvents,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
    sessionFiles,
    memoryBindings,
    executionStorage: createPostgresExecutionStorage({
      tenantId,
      conversation: conversationRuntime.conversation,
      providerContinuations: conversationRuntime.providerContinuations,
      clientEvents,
      createEventPersister: (context) => new AsyncKernelEventPersister(
        runtimeStorage,
        clientEvents,
        context,
        fileHistory,
      ),
      resultReader: {
        getRun: (sessionId, runId) => conversationRuntime.runs.getRun(tenantId, sessionId, runId),
        getMessageById: (sessionId, messageId) => conversationRuntime.conversation.getMessageById(sessionId, messageId),
        listRunSteps: (input) => conversationRuntime.runs.listRunSteps({ tenantId, ...input }),
      },
      memoryCandidates,
      consumePendingFollowups: async (followups) =>
        (await runtimeStorage.operations.consumePendingFollowups(followups)).messages,
    }),
    pathAccessPolicyFactory: () => new PathApprovalService(),
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
    hostToolRegistry: new HostToolRegistry(),
    delegationPending: new DelegationPendingService(),
    eventDispatcher: outboxDispatcher,
    capabilities: {
      sessions: sessionApplication,
      fileHistory,
      sessionFiles,
      memory,
    },
    closeInfrastructure: () => {
      backgroundTasks.dispose();
      // Shared process-level outbox dispatcher is owned by conversationRuntime.
      realtimeEvents.close();
      // Drop this tenant's MCP connections when the container is idle-closed.
      conversationRuntime.providerMcpApplication.dropMcpRuntime(tenantId);
      void sandboxLeases?.closeAll();
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
  await runtime.systemConfig.reload();
}
