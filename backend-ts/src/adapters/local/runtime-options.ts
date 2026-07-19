import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { TenantId } from "../../identity/types.js";
import type { MemoryRepository } from "../../contracts/memory-store/index.js";
import type { MemoryConfig } from "../../contracts/system-config.js";
import type { KnowledgeBaseEmbedderFactory, KnowledgeBaseService } from "../../services/knowledge/knowledge-base-service.js";
import type { MemoryRuntimeBindings } from "../../services/agent/memory/runtime-bindings.js";
import type { SessionMetadataPort } from "../../services/agent/context/types.js";
import type { RuntimeMemorySessionPort } from "../../tools/MemoryTools/MemoryExecution.js";
import type { AgentExecutionLogger } from "../../services/agent/execution/index.js";
import type { AsyncKernelEventPersister, AsyncPersisterRunContext } from "../../services/agent/sdk/async-event-persister.js";
import type { AsyncConversationHistoryPort, AsyncProviderContinuationLookupPort, SuspendedSessionControlPort } from "../../contracts/runtime-async-ports.js";
import type { AsyncBackgroundTaskRepository } from "../../contracts/background-task-repository.js";
import type { RealtimeEventBus } from "../../contracts/realtime-event-bus.js";
import type { AsyncDurableClientEventPublisher } from "../../services/runtime/event-outbox/async-client-event-publisher.js";
import type { ExecutionStorage } from "../../contracts/execution-storage.js";
import type { KnowledgeQueryPort } from "../../contracts/knowledge/query-port.js";

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
  embedderFactory?: KnowledgeBaseEmbedderFactory;
  memoryBindingsFactory?: MemoryRuntimeBindingsFactory;
  asyncEventPersisterFactory?: (context: AsyncPersisterRunContext) => AsyncKernelEventPersister;
  asyncConversationHistory?: AsyncConversationHistoryPort;
  asyncProviderContinuations?: AsyncProviderContinuationLookupPort;
  asyncClientEventsFactory?: (realtimeEvents: RealtimeEventBus) => AsyncDurableClientEventPublisher;
  asyncSuspendedSessionControlFactory?: (tenantId: TenantId) => SuspendedSessionControlPort;
  asyncBackgroundTasks?: AsyncBackgroundTaskRepository;
  knowledgeQueryFactory?: KnowledgeRuntimeQueryFactory;
  executionStorage?: ExecutionStorage;
  executionStorageFactory?: (input: { tenantId: TenantId; asyncClientEvents?: AsyncDurableClientEventPublisher }) => ExecutionStorage;
}

export interface KnowledgeRuntimeQueryFactoryInput { tenantId: TenantId; baseKnowledge: KnowledgeBaseService; }
export type KnowledgeRuntimeQueryFactory = (input: KnowledgeRuntimeQueryFactoryInput) => KnowledgeQueryPort;
export interface MemoryRuntimeBindingsFactoryInput<TMemoryRepository extends MemoryRepository = MemoryRepository> { tenantId: TenantId; dataRoot: string; memoryConfig: MemoryConfig; memoryRepository: TMemoryRepository; sessions: RuntimeMemorySessionPort & SessionMetadataPort; }
export type MemoryRuntimeBindingsFactory<TMemoryRepository extends MemoryRepository = MemoryRepository> = (input: MemoryRuntimeBindingsFactoryInput<TMemoryRepository>) => MemoryRuntimeBindings;
export type RuntimeContainerOptions = LocalRuntimeContainerOptions;
