import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { BackendPluginRuntimeHandle, BackendRuntimeContributions } from "../../plugins/backend-plugin.js";
import type { CapabilityRegistry } from "../../plugins/capability-registry.js";

import type { AnalyticsApplication } from "../application/analytics-application.js";
import type { FileChangeApplication } from "../application/file-change-application.js";
import type { MonitoringApplication } from "../application/monitoring-application.js";
import type { SessionFileApplication } from "../application/session-file-application.js";
import type { ExecutionReadApplication } from "../execution/execution-read-application.js";
import type { ExecutionStorage } from "../execution/execution-storage.js";
import type { AsyncFileHistoryStore } from "../file-history-store/index.js";
import type { PathAccessPolicy } from "./path-access-policy.js";
import type { InteractionCoordinator, PendingInteractionPort } from "./pending-interactions.js";
import type { RealtimeEventBus } from "./realtime-event-bus.js";
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
import type { SystemConfigService } from "../../services/config/system-config-service.js";
import type { McpService } from "../../services/integrations/mcp-service.js";
import type { ModelAdapterService } from "../../services/integrations/model-adapter-service.js";
import type { SkillLibraryService } from "../../services/skills/skill-library-service.js";
import type { BackgroundTaskService } from "../../services/runtime/background-task-service.js";
import type { DelegationPendingService } from "../../services/runtime/delegation-pending-service.js";
import type { HostToolRegistry } from "../../services/runtime/host-tool-registry.js";
import type { PermissionPolicyService } from "../../services/runtime/permission-policy-service.js";
import type { SessionNotificationQueue } from "../../services/runtime/session-notification-queue.js";
import type { SkillToolService } from "../../tools/SkillTools/SkillExecution.js";
import type { TaskToolService } from "../../tools/TaskTools/TaskExecution.js";
import type { GoalStore } from "./goals.js";
import type {
  AgentDelegationStorePort,
  AgentMetricsStorePort,
  CompressionHistoryPort,
  ClientEventPublisherPort,
  PermissionPolicyStorePort,
  RuntimeEventDispatcherPort,
} from "./core-runtime-ports.js";

/** Local request applications assembled around Local infrastructure. */
export interface LocalRuntimeCapabilities {
  createSessionApplication(tenantId: TenantId): SessionApplication;
  analytics: AnalyticsApplication;
  monitoring: MonitoringApplication;
  executionRead: ExecutionReadApplication;
  sessionFiles: SessionFileApplication;
  fileChanges: FileChangeApplication;
}

/** SaaS-only tenant-bound applications backed by PostgreSQL and object storage. */
export interface SaaSRuntimeCapabilities {
  sessions: SessionApplication & ExecutionSessionPort;
  fileHistory: AsyncFileHistoryStore;
  sessionFiles: AsyncSessionFileStorage;
}

/** Deployment-neutral runtime assembled by the shared execution core. */
export interface RuntimeContainerBase {
  readonly deploymentKind: "local" | "saas";
  readonly tenantId: TenantId;
  readonly pluginCapabilities: CapabilityRegistry;
  readonly sessionApplication: SessionApplication;
  readonly realtimeEvents: RealtimeEventBus;
  readonly sessionFiles: SessionFileLookupPort;
  readonly agentExecution: AgentExecutionService;
  readonly metricsCollector: AgentMetricsCollector;
  readonly permissionPolicy: PermissionPolicyService;
  readonly agentConfig: AgentConfigService;
  readonly modelAdapter: ModelAdapterService;
  readonly systemConfig: SystemConfigService;
  readonly mcp: McpService;
  readonly documentTools: DocumentToolPort | null;
  readonly codeExecutionTools: CodeExecutionPort | null;
  readonly skillTools: SkillToolService;
  readonly skillLibrary: SkillLibraryService;
  readonly searchTools: WorkspaceSearchPort | null;
  readonly bashTools: CommandExecutionPort | null;
  readonly backgroundTasks: BackgroundTaskService;
  readonly taskTools: TaskToolService;
  readonly goalStore: GoalStore;
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
  pluginCapabilities?: CapabilityRegistry;
  dataRoot: string;
  logger?: AgentExecutionLogger | undefined;
  hooks?: ((registry: HookRegistry) => void) | undefined;
  plugins?: BackendRuntimeContributions | undefined;
  pluginRuntime?: BackendPluginRuntimeHandle | undefined;
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
  goalStore: GoalStore;
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
