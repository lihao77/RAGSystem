import path from "node:path";

import type { HookRegistry } from "@ragsystem/agent-sdk";
import { RunSandboxManager } from "@ragsystem/sandbox-runtime";
import type { BackendRuntimeContributions } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { EXECUTION_ENVIRONMENT_CAPABILITY, createSaaSExecutionEnvironment } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";

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
import { TaskToolService } from "@ragsystem/backend-core/tools/TaskTools/TaskExecution.js";
import { SaaSSessionApplication } from "../application/session/saas-session-application.js";
import { toModelProviderConfig } from "../application/provider/provider-config-mapping.js";
import { SaaSAgentMetricsStore } from "../postgres/saas-agent-metrics-store.js";
import { SaaSPermissionPolicyStore } from "../postgres/saas-permission-policy-store.js";
import { createPostgresExecutionStorage } from "../postgres/postgres-execution-storage.js";
import type { SaaSConversationRuntimeHandle } from "./saas-conversation-runtime.js";
import type { SandboxDriver } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { SaaSSandboxFileBridge } from "../sandbox/sandbox-file-bridge.js";
export interface SaaSRuntimeContainerOptions {
  tenantId: TenantId;
  dataRoot: string;
  conversationRuntime: SaaSConversationRuntimeHandle;
  logger?: AgentExecutionLogger;
  hooks?: (registry: HookRegistry) => void;
  plugins?: BackendRuntimeContributions;
  modelAdapterProvidersConfigPath?: string;
  sandboxDriver: SandboxDriver;
  sandboxLeaseTimeoutSeconds?: number;
}

/** Assemble a tenant runtime without constructing any Local or SQLite adapter. */
export async function createSaaSRuntimeContainer(options: SaaSRuntimeContainerOptions): Promise<SaaSRuntimeContainer> {
  if (!options.sandboxDriver) {
    throw new Error("SaaS runtime container requires a sandbox driver");
  }
  const { tenantId, conversationRuntime } = options;
  const dataRoot = path.resolve(options.dataRoot);
  const runtimeStorage = conversationRuntime.createRuntimeStorage(tenantId);
  const realtimeEvents = conversationRuntime.createRealtimeEventBus(tenantId);
  // Fast-path publisher: claim+deliver newly written rows via the shared process dispatcher.
  // Recovery polling is owned by conversationRuntime.sharedOutboxDispatcher (one per process).
  const outboxDispatcher = conversationRuntime.sharedOutboxDispatcher;
  const clientEvents = new DurableClientEventPublisher(runtimeStorage, {
    dispatchRows: (rows) => outboxDispatcher.dispatchRows(rows),
    dispatchPendingRows: (rows) => outboxDispatcher.dispatchPendingRows(rows),
    // ephemeral 帧：仅本进程扇出（跨实例广播依赖 outbox+NOTIFY，ephemeral 不落库故为 best-effort，
    // 只有连到执行实例的客户端能收到——进度类帧可接受；需要可靠送达请用 durable）。
    dispatchEphemeral: (sessionId, event) => {
      realtimeEvents.publish(sessionId, event);
      return Promise.resolve();
    },
  });
  const fileHistory = conversationRuntime.createFileHistoryStorage(tenantId);
  const sessionFiles = conversationRuntime.createSessionFileStorage(tenantId);
  const agentConfig = new AgentConfigService(conversationRuntime.createAgentConfigTeamStore(tenantId));
  await agentConfig.initialize();
  const sessionApplication = new SaaSSessionApplication(
    tenantId,
    conversationRuntime.conversation,
    agentConfig,
    fileHistory,
    conversationRuntime.runs,
    conversationRuntime.outbox,
    conversationRuntime.workspaces,
  );
  // SaaS providers are Postgres-backed; ModelAdapterService is a pure in-process projection.
  // Keep provider configuration process-local so create/update never writes providers.yaml under dataRoot.
  const modelAdapter = new ModelAdapterService({
    providersConfigPath: options.modelAdapterProvidersConfigPath ?? "",
  });
  // SaaS system config is Postgres-backed; SystemConfigService is an in-process projection.
  const systemConfig = new SystemConfigService(
    conversationRuntime.createSystemConfigStore(tenantId),
  );
  await systemConfig.initialize();
  const notificationQueue = new SessionNotificationQueue();
  const backgroundTasks = new BackgroundTaskService({
    notificationQueue,
    repository: conversationRuntime.backgroundTasks,
    tenantId,
    clientEvents,
  });
  const goalStore = conversationRuntime.createGoalStore(tenantId);
  const taskTools = new TaskToolService(
    backgroundTasks,
    notificationQueue,
    goalStore,
  );
  const permissionPolicyStore = new SaaSPermissionPolicyStore(tenantId, conversationRuntime.conversation);
  const sandboxFileBridge = new SaaSSandboxFileBridge(
    sessionFiles,
    conversationRuntime.createWorkspaceBlobStorage(tenantId),
  );
  const sandboxRuntime = new RunSandboxManager(
    tenantId,
    options.sandboxDriver,
    options.sandboxLeaseTimeoutSeconds,
    sandboxFileBridge,
  );
  const pluginRuntime = await options.plugins?.createRuntime({
    deploymentKind: "saas",
    tenantId,
    dataRoot,
    modelAdapter,
    systemConfig,
    agentConfig,
    sessions: sessionApplication,
    backgroundTasks,
    clientEvents,
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.sandboxRuntime, sandboxRuntime, "@ragsystem/backend-saas")],
  });
  const pluginCapabilities = pluginRuntime?.capabilities ?? new CapabilityRegistry();
  pluginCapabilities.provide(
    EXECUTION_ENVIRONMENT_CAPABILITY,
    createSaaSExecutionEnvironment(),
    "@ragsystem/backend-saas",
  );

  return createCoreRuntimeContainer({
    deploymentKind: "saas",
    tenantId,
    pluginCapabilities,
    dataRoot,
    ...(options.logger ? { logger: options.logger } : {}),
    hooks: (registry: HookRegistry) => {
      options.hooks?.(registry);
      registry.on("run.finally", async ({ session, status }) => {
        // A recoverable interrupt resumes the same run and therefore retains its lease.
        if (status === "suspended") return;
        try {
          await sandboxRuntime.releaseRun(session.sessionId, session.runId, {
            collectOutputs: status === "completed" || status === "failed",
          });
        } catch (error) {
          options.logger?.error({
            tenantId,
            sessionId: session.sessionId,
            runId: session.runId,
            status,
            error: error instanceof Error ? error.message : String(error),
          }, "Sandbox output collection or cleanup failed");
          throw error;
        }
      });
    },
    ...(options.plugins ? { plugins: options.plugins } : {}),
    ...(pluginRuntime ? { pluginRuntime } : {}),
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
    sessionFiles,
    executionStorage: createPostgresExecutionStorage({
      tenantId,
      agentMailbox: conversationRuntime.createAgentMailboxStore(tenantId),
      commitRunInput: (input) => runtimeStorage.operations.commitRunInput(input),
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
        listRuns: (sessionId, limit, offset) => conversationRuntime.runs.listRuns(tenantId, sessionId, limit, offset),
        getMessageById: (sessionId, messageId) => conversationRuntime.conversation.getMessageById(sessionId, messageId),
        listRunSteps: (input) => conversationRuntime.runs.listRunSteps({ tenantId, ...input }),
      },
    }),
    pathAccessPolicyFactory: () => new PathApprovalService(),
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
    },
    closeInfrastructure: async () => {
      backgroundTasks.dispose();
      // Shared process-level outbox dispatcher is owned by conversationRuntime.
      realtimeEvents.close();
      try {
        await sandboxRuntime.closeAll();
      } finally {
        pluginRuntime?.dispose();
      }
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
    (await conversationRuntime.providers.listProviders(tenantId)).map(toModelProviderConfig),
  );
  await runtime.systemConfig.reload();
}
