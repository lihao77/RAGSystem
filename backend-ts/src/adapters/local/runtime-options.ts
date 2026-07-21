import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { TenantId } from "../../identity/types.js";
import type { MemoryRepository } from "../../contracts/memory-store/index.js";
import type { MemoryConfig } from "../../contracts/runtime/system-config.js";
import type { KnowledgeEmbedderFactory } from "../../services/knowledge/knowledge-application-service.js";
import type { MemoryRuntimeBindings } from "../../services/agent/memory/runtime-bindings.js";
import type { SessionMetadataPort } from "../../services/agent/context/types.js";
import type { RuntimeMemorySessionPort } from "../../tools/MemoryTools/MemoryExecution.js";
import type { AgentExecutionLogger } from "../../services/agent/execution/index.js";
import type { AsyncConversationHistoryPort, AsyncProviderContinuationLookupPort, SuspendedSessionControlPort } from "../../contracts/runtime/runtime-async-ports.js";
import type { AsyncBackgroundTaskRepository } from "../../contracts/storage/background-task-repository.js";
import type { RealtimeEventBus } from "../../contracts/runtime/realtime-event-bus.js";
import type { AsyncDurableClientEventPublisher } from "../../services/runtime/event-outbox/async-client-event-publisher.js";
import type { ExecutionStorage } from "../../contracts/execution/execution-storage.js";
import type { PathAccessPolicy } from "../../contracts/runtime/path-access-policy.js";
import type { AsyncAnalyticsRepository } from "../../contracts/storage/async-persistence-ports.js";
import type { RuntimeStorage } from "../../contracts/storage/runtime-storage.js";

export interface LocalRuntimeContainerOptions {
  tenantId: TenantId;
  dbPath: string;
  dataRoot?: string;
  logger?: AgentExecutionLogger;
  modelAdapterProvidersConfigPath?: string;
  mcpConfigPath?: string;
  systemConfigPath?: string;
  agentConfigRoot?: string;
  startOutboxDispatcher?: boolean;
  outboxDispatcherIntervalMs?: number;
  hooks?: (registry: HookRegistry) => void;
  embedderFactory?: KnowledgeEmbedderFactory;
  memoryBindingsFactory?: MemoryRuntimeBindingsFactory;
  asyncConversationHistory?: AsyncConversationHistoryPort;
  asyncProviderContinuations?: AsyncProviderContinuationLookupPort;
  asyncClientEventsFactory?: (
    tenantId: TenantId,
    realtimeEvents: RealtimeEventBus,
    runtimeStorage: RuntimeStorage,
  ) => AsyncDurableClientEventPublisher;
  asyncSuspendedSessionControlFactory?: (tenantId: TenantId) => SuspendedSessionControlPort;
  asyncBackgroundTasks?: AsyncBackgroundTaskRepository;
  asyncAnalytics?: AsyncAnalyticsRepository;
  executionStorage?: ExecutionStorage;
  runtimeStorageFactory?: (tenantId: TenantId) => RuntimeStorage;
  executionStorageFactory?: (input: { tenantId: TenantId; runtimeStorage: RuntimeStorage; asyncClientEvents: AsyncDurableClientEventPublisher }) => ExecutionStorage;
  hostToolsEnabled?: boolean;
  pathAccessPolicyFactory?: () => PathAccessPolicy;
}

export interface MemoryRuntimeBindingsFactoryInput<TMemoryRepository extends MemoryRepository = MemoryRepository> { tenantId: TenantId; dataRoot: string; memoryConfig: MemoryConfig; memoryRepository: TMemoryRepository; sessions: RuntimeMemorySessionPort & SessionMetadataPort; }
export type MemoryRuntimeBindingsFactory<TMemoryRepository extends MemoryRepository = MemoryRepository> = (input: MemoryRuntimeBindingsFactoryInput<TMemoryRepository>) => MemoryRuntimeBindings;
export type RuntimeContainerOptions = LocalRuntimeContainerOptions;
