import type { HookRegistry } from "@ragsystem/agent-sdk";

import type { ArtifactApplication } from "../artifacts/artifact-application.js";
import type { ConversationStore } from "../conversation-store/index.js";
import type { ExecutionStorage } from "../execution/execution-storage.js";
import type { IFileHistoryStore, AsyncFileHistoryStore } from "../file-history-store/index.js";
import type { IFileIndexStore } from "../file-index-store/index.js";
import type { KnowledgeQueryPort } from "../knowledge/query-port.js";
import type { IMemoryStore } from "../memory-store/index.js";
import type { PathAccessPolicy } from "./path-access-policy.js";
import type { InteractionCoordinator, PendingInteractionPort } from "./pending-interactions.js";
import type { RealtimeEventBus } from "./realtime-event-bus.js";
import type { MemoryConfig } from "./system-config.js";
import type { CommandExecutionPort, CodeExecutionPort, DocumentToolPort, WorkspaceSearchPort } from "./tool-ports.js";
import type { AsyncSessionFileStorage, SessionFileLookupPort } from "../session/session-file-storage.js";
import type { ExecutionSessionPort, SessionApplication } from "../session/session-application.js";
import type { RuntimeStorage } from "../storage/runtime-storage.js";
import type { TenantId } from "../../identity/types.js";
import type { AgentConfigService } from "../../services/agent/config/index.js";
import type { AgentDelegationService } from "../../services/agent/delegation/index.js";
import type { AgentExecutionLogger, AgentExecutionService } from "../../services/agent/execution/index.js";
import type { RuntimeCoreService } from "../../services/agent/execution/runtime-core-service.js";
import type { AgentMetricsCollector } from "../../services/agent/metrics/metrics-collector.js";
import type { MemoryRuntimeBindings } from "../../services/agent/memory/runtime-bindings.js";
import type { ArtifactService } from "../../services/artifacts/artifact-service.js";
import type { TransientArtifactService } from "../../services/artifacts/transient-artifact-service.js";
import type { SystemConfigService } from "../../services/config/system-config-service.js";
import type { McpService } from "../../services/integrations/mcp-service.js";
import type { ModelAdapterService } from "../../services/integrations/model-adapter-service.js";
import type { KnowledgeApplicationService } from "../../services/knowledge/knowledge-application-service.js";
import type { AsyncKnowledgeFileStore } from "../knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../knowledge/async-knowledge-markdown-pipeline.js";
import type { MemoryApplication } from "../../services/memory/index.js";
import type { AgentSessionApplication } from "../../services/sessions/index.js";
import type { SkillLibraryService } from "../../services/skills/skill-library-service.js";
import type { BackgroundTaskService } from "../../services/runtime/background-task-service.js";
import type { DelegationPendingService } from "../../services/runtime/delegation-pending-service.js";
import type { HostToolRegistry } from "../../services/runtime/host-tool-registry.js";
import type { PermissionPolicyService } from "../../services/runtime/permission-policy-service.js";
import type { SessionNotificationQueue } from "../../services/runtime/session-notification-queue.js";
import type { MemoryToolOperations } from "../../tools/MemoryTools/MemoryExecution.js";
import type { SkillToolService } from "../../tools/SkillTools/SkillExecution.js";
import type { TaskToolService } from "../../tools/TaskTools/TaskExecution.js";
import type {
  AgentDelegationStorePort,
  AgentMetricsStorePort,
  CompressionHistoryPort,
  ClientEventPublisherPort,
  PermissionPolicyStorePort,
  RuntimeEventDispatcherPort,
} from "./core-runtime-ports.js";

/** Local-only synchronous administration and filesystem capabilities. */
export interface LocalRuntimeCapabilities {
  conversationStore: ConversationStore;
  sessions: AgentSessionApplication;
  fileHistory: IFileHistoryStore;
  fileIndex: IFileIndexStore;
  knowledgeFiles: AsyncKnowledgeFileStore;
  knowledgeMarkdown: AsyncKnowledgeMarkdownPipeline;
  knowledgeService: KnowledgeApplicationService;
  artifacts: ArtifactService;
  transientArtifacts: TransientArtifactService;
  memoryStore: IMemoryStore;
}

/** SaaS-only tenant-bound applications backed by PostgreSQL and object storage. */
export interface SaaSRuntimeCapabilities {
  sessions: SessionApplication & ExecutionSessionPort;
  fileHistory: AsyncFileHistoryStore;
  sessionFiles: AsyncSessionFileStorage;
  artifacts: ArtifactApplication;
  memory: MemoryApplication;
}

/** Deployment-neutral runtime assembled by the shared execution core. */
export interface RuntimeContainerBase {
  readonly deploymentKind: "local" | "saas";
  readonly tenantId: TenantId;
  readonly sessionApplication: SessionApplication;
  readonly realtimeEvents: RealtimeEventBus;
  readonly agentExecution: AgentExecutionService;
  readonly metricsCollector: AgentMetricsCollector;
  readonly permissionPolicy: PermissionPolicyService;
  readonly agentConfig: AgentConfigService;
  readonly modelAdapter: ModelAdapterService;
  readonly systemConfig: SystemConfigService;
  readonly mcp: McpService;
  readonly knowledge: KnowledgeQueryPort;
  readonly memoryTools: MemoryToolOperations;
  readonly memoryContextSourceFactory: MemoryRuntimeBindings["createContextSource"];
  readonly documentTools: DocumentToolPort | null;
  readonly codeExecutionTools: CodeExecutionPort | null;
  readonly skillTools: SkillToolService;
  readonly skillLibrary: SkillLibraryService;
  readonly searchTools: WorkspaceSearchPort | null;
  readonly bashTools: CommandExecutionPort | null;
  readonly backgroundTasks: BackgroundTaskService;
  readonly taskTools: TaskToolService;
  readonly pendingInteractions: PendingInteractionPort;
  readonly interactionCoordinator: InteractionCoordinator;
  readonly hostToolRegistry: HostToolRegistry;
  readonly delegationPending: DelegationPendingService;
  readonly toolsDeps: Omit<import("../../tools/registry.js").BackendToolsDeps, "agent" | "teamName">;
  readonly runtimeCore: RuntimeCoreService;
  readonly agentDelegation: AgentDelegationService;
  readonly eventDispatcher: RuntimeEventDispatcherPort;
  readonly clientEvents: ClientEventPublisherPort;
  readonly dataRoot: string;
  close(): void;
}

export interface LocalRuntimeContainer extends RuntimeContainerBase {
  readonly deploymentKind: "local";
  readonly local: LocalRuntimeCapabilities;
  readonly saas: null;
}

export interface SaaSRuntimeContainer extends RuntimeContainerBase {
  readonly deploymentKind: "saas";
  readonly local: null;
  readonly saas: SaaSRuntimeCapabilities;
}

export type RuntimeContainer = LocalRuntimeContainer | SaaSRuntimeContainer;

interface CoreRuntimeDependenciesBase {
  tenantId: TenantId;
  dataRoot: string;
  /** 每次 run 时读取最新 memory 配置（systemConfig.reload 后即时生效）。 */
  getMemoryConfig: () => MemoryConfig;
  logger?: AgentExecutionLogger | undefined;
  hooks?: ((registry: HookRegistry) => void) | undefined;
  clientEvents: ClientEventPublisherPort;
  runtimeStorage: RuntimeStorage;
  delegationStore: AgentDelegationStorePort;
  metricsStore: AgentMetricsStorePort;
  permissionPolicyStore: PermissionPolicyStorePort;
  compressionHistory: CompressionHistoryPort;
  executionSessions: ExecutionSessionPort;
  sessionApplication: SessionApplication;
  realtimeEvents: RealtimeEventBus;
  agentConfig: AgentConfigService;
  modelAdapter: ModelAdapterService;
  systemConfig: SystemConfigService;
  mcp: McpService;
  sessionFiles: SessionFileLookupPort;
  knowledge: KnowledgeQueryPort;
  memoryBindings: MemoryRuntimeBindings;
  executionStorage: ExecutionStorage;
  pathAccessPolicyFactory: () => PathAccessPolicy;
  documentTools: DocumentToolPort | null;
  codeExecutionTools: CodeExecutionPort | null;
  skillTools: SkillToolService;
  skillLibrary: SkillLibraryService;
  searchTools: WorkspaceSearchPort | null;
  bashTools: CommandExecutionPort | null;
  backgroundTasks: BackgroundTaskService;
  taskTools: TaskToolService;
  notificationQueue: SessionNotificationQueue;
  hostToolRegistry: HostToolRegistry;
  delegationPending: DelegationPendingService;
  eventDispatcher: RuntimeEventDispatcherPort;
  closeInfrastructure(): void;
}

export interface LocalCoreRuntimeDependencies extends CoreRuntimeDependenciesBase {
  deploymentKind: "local";
  capabilities: LocalRuntimeCapabilities;
}

export interface SaaSCoreRuntimeDependencies extends CoreRuntimeDependenciesBase {
  deploymentKind: "saas";
  capabilities: SaaSRuntimeCapabilities;
}

export type CoreRuntimeDependencies = LocalCoreRuntimeDependencies | SaaSCoreRuntimeDependencies;
