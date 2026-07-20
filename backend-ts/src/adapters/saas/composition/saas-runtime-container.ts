import type { RuntimeContainer } from "../../../contracts/runtime/runtime-container.js";
import type { RealtimeEventBus } from "../../../contracts/runtime/realtime-event-bus.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { TenantId } from "../../../identity/types.js";
import { createLocalRuntimeContainer } from "../../local/runtime-container.js";
import type { LocalRuntimeContainerOptions } from "../../local/runtime-options.js";
import { createPostgresExecutionStorage } from "../postgres/postgres-execution-storage.js";
import { AsyncKernelEventPersister } from "../../../services/agent/sdk/async-event-persister.js";
import { AsyncDurableClientEventPublisher } from "../../../services/runtime/event-outbox/async-client-event-publisher.js";
import { AsyncOutboxDispatcher } from "../../../services/runtime/event-outbox/async-dispatcher.js";
import type { SaaSConversationRuntimeHandle } from "./saas-conversation-runtime.js";
import type { SaaSMemoryRuntimeHandle } from "./saas-memory-runtime.js";

type SaaSOwnedRuntimeOption =
  | "asyncAnalytics"
  | "asyncBackgroundTasks"
  | "asyncClientEventsFactory"
  | "asyncConversationHistory"
  | "asyncProviderContinuations"
  | "executionStorage"
  | "executionStorageFactory"
  | "hostToolsEnabled"
  | "knowledgeQueryFactory"
  | "memoryBindingsFactory"
  | "runtimeStorageFactory";

/**
 * Tenant-local inputs that remain necessary while RuntimeContainer still
 * exposes synchronous configuration, session and file-index services.
 * PostgreSQL-backed runtime behavior is owned by this SaaS composition root.
 */
export interface SaaSRuntimeContainerOptions
  extends Omit<LocalRuntimeContainerOptions, SaaSOwnedRuntimeOption> {
  conversationRuntime: SaaSConversationRuntimeHandle;
  memoryRuntime?: SaaSMemoryRuntimeHandle;
}

/** Assemble one tenant's agent runtime with the SaaS persistence adapters. */
export function createSaaSRuntimeContainer(options: SaaSRuntimeContainerOptions): RuntimeContainer {
  const { conversationRuntime, memoryRuntime, ...baseOptions } = options;
  return createLocalRuntimeContainer({
    ...baseOptions,
    deploymentKind: "saas",
    hostToolsEnabled: false,
    ...(memoryRuntime ? {
      memoryBindingsFactory: (input) => memoryRuntime.provider.createMemoryBindings(
        input.tenantId,
        input.sessions,
      ),
    } : {}),
    runtimeStorageFactory: (tenantId) => conversationRuntime.createRuntimeStorage(tenantId),
    asyncConversationHistory: conversationRuntime.conversation,
    asyncBackgroundTasks: conversationRuntime.backgroundTasks,
    asyncAnalytics: conversationRuntime.analytics,
    asyncProviderContinuations: conversationRuntime.providerContinuations,
    knowledgeQueryFactory: ({ tenantId, baseKnowledge }) => conversationRuntime.createKnowledgeQuery(
      tenantId,
      baseKnowledge,
    ),
    asyncClientEventsFactory: (_tenantId, realtimeEvents, runtimeStorage) => createSaaSClientEvents(
      conversationRuntime,
      realtimeEvents,
      runtimeStorage,
    ),
    executionStorageFactory: ({ tenantId, runtimeStorage, asyncClientEvents }) => createPostgresExecutionStorage({
      tenantId,
      conversation: conversationRuntime.conversation,
      providerContinuations: conversationRuntime.providerContinuations,
      clientEvents: asyncClientEvents,
      createEventPersister: (context) => new AsyncKernelEventPersister(
        runtimeStorage,
        asyncClientEvents,
        context,
        conversationRuntime.createFileHistoryStorage(context.tenantId),
      ),
    }),
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

function createSaaSClientEvents(
  conversationRuntime: SaaSConversationRuntimeHandle,
  realtimeEvents: RealtimeEventBus,
  runtimeStorage: RuntimeStorage,
): AsyncDurableClientEventPublisher {
  return new AsyncDurableClientEventPublisher(
    runtimeStorage,
    new AsyncOutboxDispatcher(conversationRuntime.outbox, realtimeEvents),
  );
}
