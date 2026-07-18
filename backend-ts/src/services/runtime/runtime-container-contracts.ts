import type { HookRegistry } from "@ragsystem/agent-sdk";

import type { MemoryStore } from "../../adapters/local/memory-store.js";
import type { IFileHistoryStore } from "../../contracts/file-history-store/index.js";
import type { IFileIndexStore } from "../../contracts/file-index-store/index.js";
import type { MemoryRepository } from "../../contracts/memory-store/index.js";
import type { MemoryConfig } from "../../contracts/system-config.js";
import type { TenantId } from "../../identity/types.js";
import type { LocalBashToolService } from "../../tools/BashTool/BashExecution.js";
import type { CodeExecutionToolService } from "../../tools/CodeExecutionTool/CodeExecution.js";
import type { LocalDocumentToolService } from "../../tools/DocumentTools/DocumentExecution.js";
import type { MemoryToolOperations, RuntimeMemorySessionPort } from "../../tools/MemoryTools/MemoryExecution.js";
import type { LocalSearchToolService } from "../../tools/LocalSearchTools/SearchExecution.js";
import type { SkillToolService } from "../../tools/SkillTools/SkillExecution.js";
import type { TaskToolService } from "../../tools/TaskTools/TaskExecution.js";
import type { AgentConfigService } from "../agent/config/index.js";
import type { AgentDelegationService } from "../agent/delegation/index.js";
import type { AgentCompressionService } from "../agent/context-compression/compression-service.js";
import type { AgentExecutionLogger, AgentExecutionService } from "../agent/execution/index.js";
import type { ResumeExecutor } from "../agent/execution/resume-executor.js";
import type { RuntimeCoreService } from "../agent/execution/runtime-core-service.js";
import type { AgentMetricsCollector } from "../agent/metrics/metrics-collector.js";
import type { MemoryRuntimeBindings } from "../agent/memory/runtime-bindings.js";
import type { SessionMetadataPort } from "../agent/context/types.js";
import type { ArtifactService } from "../artifacts/artifact-service.js";
import type { TransientArtifactService } from "../artifacts/transient-artifact-service.js";
import type { SystemConfigService } from "../config/system-config-service.js";
import type { McpService } from "../integrations/mcp-service.js";
import type { ModelAdapterService } from "../integrations/model-adapter-service.js";
import type { EmbeddingModelService } from "../knowledge/embedding-model-service.js";
import type { KnowledgeBaseEmbedderFactory, KnowledgeBaseService } from "../knowledge/knowledge-base-service.js";
import type { AgentSessionApplication } from "../sessions/index.js";
import type { ConversationStore } from "../stores/conversation-store/index.js";
import type { SkillLibraryService } from "../skills/skill-library-service.js";
import type { BackgroundTaskService } from "./background-task-service.js";
import type { DelegationPendingService } from "./delegation-pending-service.js";
import type { DurableClientEventPublisher } from "./event-outbox/client-event-publisher.js";
import type { OutboxDispatcher } from "./event-outbox/dispatcher.js";
import type { HostToolRegistry } from "./host-tool-registry.js";
import type { PendingInteractionService } from "./pending-interaction-service.js";
import type { PermissionPolicyService } from "./permission-policy-service.js";
import type { RealtimeEventHub } from "./realtime-event-hub.js";
import type { SessionNotificationQueue } from "./session-notification-queue.js";
import type { AsyncDurableClientEventPublisher } from "./event-outbox/async-client-event-publisher.js";
import type { AsyncKernelEventPersister, AsyncPersisterRunContext } from "../agent/sdk/async-event-persister.js";

export interface RuntimeContainer<TMemoryRepository extends MemoryRepository = MemoryStore> {
  readonly conversationStore: ConversationStore;
  readonly sessionApplication: AgentSessionApplication;
  readonly realtimeEvents: RealtimeEventHub;
  readonly agentExecution: AgentExecutionService;
  readonly resumeExecutor: ResumeExecutor;
  readonly metricsCollector: AgentMetricsCollector;
  readonly permissionPolicy: PermissionPolicyService;
  readonly agentConfig: AgentConfigService;
  readonly modelAdapter: ModelAdapterService;
  readonly systemConfig: SystemConfigService;
  readonly mcp: McpService;
  readonly fileHistory: IFileHistoryStore;
  readonly fileIndex: IFileIndexStore;
  readonly knowledgeBase: KnowledgeBaseService;
  readonly artifacts: ArtifactService;
  readonly transientArtifacts: TransientArtifactService;
  readonly embeddingModels: EmbeddingModelService;
  readonly memoryStore: TMemoryRepository;
  readonly memoryTools: MemoryToolOperations;
  readonly documentTools: LocalDocumentToolService;
  readonly codeExecutionTools: CodeExecutionToolService;
  readonly skillTools: SkillToolService;
  readonly skillLibrary: SkillLibraryService;
  readonly searchTools: LocalSearchToolService;
  readonly bashTools: LocalBashToolService;
  readonly backgroundTasks: BackgroundTaskService;
  readonly taskTools: TaskToolService;
  readonly pendingInteractions: PendingInteractionService;
  readonly hostToolRegistry: HostToolRegistry;
  readonly delegationPending: DelegationPendingService;
  readonly toolsDeps: Omit<import("../../tools/registry.js").BackendToolsDeps, "agent" | "teamName">;
  readonly runtimeCore: RuntimeCoreService;
  readonly agentDelegation: AgentDelegationService;
  readonly outboxDispatcher: OutboxDispatcher;
  readonly clientEvents: DurableClientEventPublisher;
  readonly dataRoot: string;
  close(): void;
}

export interface LocalRuntimeContainerOptions {
  tenantId: TenantId;
  dbPath: string;
  dataRoot?: string | undefined;
  logger?: AgentExecutionLogger | undefined;
  modelAdapterProvidersConfigPath?: string | undefined;
  mcpConfigPath?: string | undefined;
  systemConfigPath?: string | undefined;
  agentConfigRoot?: string | undefined;
  startOutboxDispatcher?: boolean | undefined;
  outboxDispatcherIntervalMs?: number | undefined;
  hooks?: ((registry: HookRegistry) => void) | undefined;
  embedderFactory?: KnowledgeBaseEmbedderFactory | undefined;
  memoryBindingsFactory?: MemoryRuntimeBindingsFactory | undefined;
  asyncEventPersisterFactory?: (context: AsyncPersisterRunContext) => AsyncKernelEventPersister;
  asyncClientEventsFactory?: (realtimeEvents: RealtimeEventHub) => AsyncDurableClientEventPublisher;
}

export interface MemoryRuntimeBindingsFactoryInput<TMemoryRepository extends MemoryRepository = MemoryRepository> {
  tenantId: TenantId;
  dataRoot: string;
  memoryConfig: MemoryConfig;
  memoryRepository: TMemoryRepository;
  sessions: RuntimeMemorySessionPort & SessionMetadataPort;
}

export type MemoryRuntimeBindingsFactory<TMemoryRepository extends MemoryRepository = MemoryRepository> = (
  input: MemoryRuntimeBindingsFactoryInput<TMemoryRepository>,
) => MemoryRuntimeBindings;

/** Backwards-compatible name for callers that still use the original factory. */
export type RuntimeContainerOptions = LocalRuntimeContainerOptions;

/**
 * Services prepared by a deployment adapter before the shared agent runtime is assembled.
 * Infrastructure services are narrowed to ports as their deployment-specific implementations
 * are extracted. The memory dependency is the first such boundary.
 */
export interface CoreRuntimeDependencies<TMemoryRepository extends MemoryRepository = MemoryRepository> {
  tenantId: TenantId;
  dataRoot: string;
  memoryConfig: MemoryConfig;
  logger?: AgentExecutionLogger | undefined;
  hooks?: ((registry: HookRegistry) => void) | undefined;
  asyncEventPersisterFactory?: (context: AsyncPersisterRunContext) => AsyncKernelEventPersister;
  asyncClientEvents?: AsyncDurableClientEventPublisher;
  conversationStore: ConversationStore;
  sessionApplication: AgentSessionApplication;
  realtimeEvents: RealtimeEventHub;
  permissionPolicy: PermissionPolicyService;
  agentConfig: AgentConfigService;
  modelAdapter: ModelAdapterService;
  systemConfig: SystemConfigService;
  mcp: McpService;
  fileHistory: IFileHistoryStore;
  fileIndex: IFileIndexStore;
  knowledgeBase: KnowledgeBaseService;
  artifacts: ArtifactService;
  transientArtifacts: TransientArtifactService;
  embeddingModels: EmbeddingModelService;
  memoryStore: TMemoryRepository;
  memoryBindings: MemoryRuntimeBindings;
  documentTools: LocalDocumentToolService;
  codeExecutionTools: CodeExecutionToolService;
  skillTools: SkillToolService;
  skillLibrary: SkillLibraryService;
  searchTools: LocalSearchToolService;
  bashTools: LocalBashToolService;
  backgroundTasks: BackgroundTaskService;
  taskTools: TaskToolService;
  notificationQueue: SessionNotificationQueue;
  pendingInteractions: PendingInteractionService;
  hostToolRegistry: HostToolRegistry;
  delegationPending: DelegationPendingService;
  outboxDispatcher: OutboxDispatcher;
  clientEvents: DurableClientEventPublisher;
  closeInfrastructure(): void;
}
