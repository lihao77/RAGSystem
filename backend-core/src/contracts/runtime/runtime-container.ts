import type { HookRegistry, Tool, ToolImageSink } from "@ragsystem/agent-sdk";
import type {
  BackendContextSourceFactory,
  BackendPluginRuntimeHandle,
  BackendRuntimeContributions,
  BackendToolFactoryContext,
} from "../../plugins/backend-plugin.js";
import type { CapabilityRegistry } from "../../plugins/capability-registry.js";

import type { AnalyticsApplication } from "../application/analytics-application.js";
import type { FileChangeApplication } from "../application/file-change-application.js";
import type { MonitoringApplication } from "../application/monitoring-application.js";
import type { SessionFileApplication } from "../application/session-file-application.js";
import type { ExecutionReadApplication } from "../execution/execution-read-application.js";
import type { ExecutionStorage } from "../execution/execution-storage.js";
import type { PathAccessPolicy } from "./path-access-policy.js";
import type { InteractionCoordinator, PendingInteractionPort } from "./pending-interactions.js";
import type { RealtimeEventBus } from "./realtime-event-bus.js";
import type { SessionFileLookupPort } from "../session/session-file-storage.js";
import type { ExecutionSessionPort, SessionApplication } from "../session/session-application.js";
import type { RuntimeStorage } from "../storage/runtime-storage.js";
import type { TenantId } from "../../identity/types.js";
import type { AgentConfigService } from "../../services/agent/config/index.js";
import type { AgentDelegationService } from "../../services/agent/delegation/index.js";
import type { AgentExecutionLogger, AgentExecutionService } from "../../services/agent/execution/index.js";
import type { RuntimeCoreService } from "../../services/agent/execution/runtime-core-service.js";
import type { AgentMetricsCollector } from "../../services/agent/metrics/metrics-collector.js";
import type { SystemConfigService } from "../../services/config/system-config-service.js";
import type { ModelAdapterService } from "../../services/integrations/model-adapter-service.js";
import type { BackgroundTaskService } from "../../services/runtime/background-task-service.js";
import type { DelegationPendingService } from "../../services/runtime/delegation-pending-service.js";
import type { HostToolRegistry } from "../../services/runtime/host-tool-registry.js";
import type { PermissionPolicyService } from "../../services/runtime/permission-policy-service.js";
import type { SessionRuntimeService } from "../../services/runtime/session-runtime-service.js";
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

/** Deployment-neutral runtime assembled by the shared execution core. */
export interface RuntimeContainerBase {
  readonly deploymentKind: "local";
  readonly tenantId: TenantId;
  readonly pluginCapabilities: CapabilityRegistry;
  readonly createPluginTools: (context: BackendToolFactoryContext) => Promise<readonly Tool[]>;
  readonly listPluginTools: () => readonly import("../../plugins/backend-plugin.js").BackendToolDescriptor[];
  /** 插件贡献的前置 context source 工厂；run 与 monitoring 预览共用同一份，保证调试快照与真实 run 同源。 */
  readonly contextSourceFactories: readonly BackendContextSourceFactory[] | null;
  readonly sessionApplication: SessionApplication;
  readonly realtimeEvents: RealtimeEventBus;
  readonly sessionFiles: SessionFileLookupPort;
  readonly agentExecution: AgentExecutionService;
  readonly metricsCollector: AgentMetricsCollector;
  readonly permissionPolicy: PermissionPolicyService;
  readonly agentConfig: AgentConfigService;
  readonly modelAdapter: ModelAdapterService;
  readonly systemConfig: SystemConfigService;
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
  readonly sessionRuntime: SessionRuntimeService;
  readonly dataRoot: string;
  close(): Promise<void>;
}

export interface LocalRuntimeContainer extends RuntimeContainerBase {
  readonly deploymentKind: "local";
  readonly local: LocalRuntimeCapabilities;
}

export type RuntimeContainer = LocalRuntimeContainer;

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
  sessionFiles: SessionFileLookupPort;
  /** 工具图片持久化端口（部署注入；未注入时工具媒体回退 SDK 临时文件通道）。 */
  toolImageSink?: ToolImageSink | null;
  executionStorage: ExecutionStorage;
  pathAccessPolicyFactory: () => PathAccessPolicy;
  backgroundTasks: BackgroundTaskService;
  taskTools: TaskToolService;
  goalStore: GoalStore;
  hostToolRegistry: HostToolRegistry;
  delegationPending: DelegationPendingService;
  eventDispatcher: RuntimeEventDispatcherPort;
  closeInfrastructure(): void | Promise<void>;
}

export interface LocalCoreRuntimeDependencies extends CoreRuntimeDependenciesBase {
  deploymentKind: "local";
  capabilities: LocalRuntimeCapabilities;
}

export type CoreRuntimeDependencies = LocalCoreRuntimeDependencies;
