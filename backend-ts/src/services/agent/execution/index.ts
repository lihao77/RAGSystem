import type {
  AgentExecuteResult,
  AgentRunStartResult,
  CollaborateRequest,
  ExecuteRequest,
  ExecutionOverview,
  RollbackRetryStartResult,
  RunningTasksResult,
  ScopedExecutionDiagnostics,
  ScopedTaskStatus,
  SessionTaskStatus,
  StreamExecuteRequest,
} from "../../../contracts/execution/execution.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { ExecutionSessionPort } from "../../../contracts/session/session-application.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import { SessionNotificationQueue } from "../../runtime/session-notification-queue.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { OutboxDispatcher } from "../../runtime/event-outbox/dispatcher.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import type { TaskToolService } from "../../../tools/TaskTools/TaskExecution.js";
import type { PermissionPolicyService } from "../../runtime/permission-policy-service.js";
import type { PendingInteractionPort } from "../../../contracts/runtime/pending-interactions.js";
import type { HostToolRegistry } from "../../runtime/host-tool-registry.js";
import type { DelegationPendingService } from "../../runtime/delegation-pending-service.js";
import type { ExecutionStorage } from "../../../contracts/execution/execution-storage.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";
import { AgentExecutionEventPublisher } from "./event-publisher.js";
import { AgentExecutionStatusTracker } from "./status-tracker.js";
import { AttachmentResolver } from "./attachment-resolver.js";
import { SlashCommandHandler } from "./slash-command-handler.js";
import { AgentRunEngine, type AgentExecutionLogger } from "./run-engine.js";
import type { AgentMetricsCollector } from "../metrics/metrics-collector.js";
import type { AgentCompressionService } from "../context-compression/compression-service.js";
import type { TenantId } from "../../../identity/types.js";
import type { MemoryConfig } from "../../../contracts/runtime/system-config.js";
import type { MemoryRuntimeBindings } from "../memory/runtime-bindings.js";
import type { PathAccessPolicy } from "../../../contracts/runtime/path-access-policy.js";
import {
  createLaunchers,
  type RollbackRetryInput,
} from "./launchers.js";
import { createSessionControl } from "./session-control.js";
import { createExecutionQueryService } from "./query.js";

export type { AgentExecutionLogger } from "./run-engine.js";
export type { RollbackRetryInput } from "./launchers.js";

export interface AgentExecutionServiceApi {
  startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult>;
  executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  collaborateSequentially(
    request: CollaborateRequest,
    requestId: string,
  ): Promise<{ results: AgentExecuteResult[]; session_id: string; total_tasks: number }>;
  startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult>;
  /** 后台任务完成通知拉起的 system run（通道 A，由 BackgroundTaskService.scheduleAutoTrigger 触发）。 */
  triggerBgNotificationRun(sessionId: string): void;
  stopSession(sessionId: string): Promise<boolean>;
  getSessionTaskStatus(sessionId: string): SessionTaskStatus;
  getSessionExecutionDiagnostics(sessionId: string): ScopedExecutionDiagnostics;
  getTaskStatus(taskId: string): ScopedTaskStatus;
  getTaskExecutionDiagnostics(taskId: string): ScopedExecutionDiagnostics;
  listRunningTasks(): RunningTasksResult;
  getOverview(activeOnly: boolean): ExecutionOverview;
}

/** 兼容旧引用：类型别名指向新 Api。 */
export type AgentExecutionService = AgentExecutionServiceApi;

export interface AgentExecutionServiceParams {
  tenantId: TenantId;
  sessions: ExecutionSessionPort;
  executionStorage: ExecutionStorage;
  runtimeCore: RuntimeExecutionConfigResolver;
  dataRoot: string;
  /** 每次 run 读取最新 memory 配置（避免 container 创建时快照）。 */
  getMemoryConfig: () => MemoryConfig;
  memoryContextSourceFactory?: MemoryRuntimeBindings["createContextSource"];
  /** per-agent 工具依赖（runtime-adapter per-run 构建 Tool[] 用）。 */
  toolsDeps?: Omit<import("../../../tools/registry.js").BackendToolsDeps, "agent" | "teamName"> | null;
  codeExecutionTools?: import("../../../contracts/runtime/tool-ports.js").CodeExecutionPort | null;
  taskTools?: TaskToolService | null;
  backgroundTasks?: BackgroundTaskService | null;
  /** 后台通知暂存队列（单例，注入 launchers.triggerBgNotificationRun；与 backgroundTasks 共用同一实例）。 */
  notificationQueue?: SessionNotificationQueue | null;
  sessionFiles?: SessionFileLookupPort | null;
  outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">;
  clientEvents: ClientEventPublisher;
 /** 已加载的 provider 列表提供者（SDK 投影层解析 tier.provider 引用用）。 */
 providersProvider: () => ModelProviderConfig[];
 /** 权限策略服务（SDK 审批编排判定用）。 */
  permissionPolicy: PermissionPolicyService;
  pathAccessPolicyFactory: () => PathAccessPolicy;
 /** 审批交互服务（SDK 审批编排阻塞等待用）。 */
 pendingInteractions: PendingInteractionPort;
 /** 前端委托工具声明注册表（per-session）。 */
 hostToolRegistry: HostToolRegistry;
 /** 委托工具调用等待器（转发壳 Tool.call 注册等待 + 前端 tool_result resolve）。 */
 delegationPending: DelegationPendingService;
 /** 消费端 hook 注册回调（可选）；透传 SDK，让 backend 注册 tool.before/after、round.before 等 handler。 */
 hooks?: (registry: HookRegistry) => void;
 /** 性能指标采集器（透传 AgentRunEngine 终态落库用）。 */
 metricsCollector?: AgentMetricsCollector | null;
 logger?: AgentExecutionLogger | null | undefined;
 /** backend 压缩服务（slash /compact + run 内 round.before 共用）；A3 压缩外移。 */
  compressionService?: AgentCompressionService;
  runtimeStorage: RuntimeStorage;
}

/**
 * 组装 agent 执行服务（无主类）：创建共享实例（statusTracker/followupQueue/eventPublisher/...）
 * + runEngine + slash/attachment handler，组合 launchers/sessionControl/query 为统一 Api。
 * 类比 tools 的 createXxxTools(deps) 工厂。
 */
export function createAgentExecutionService(
  params: AgentExecutionServiceParams,
): AgentExecutionServiceApi & { runEngine: AgentRunEngine; eventPublisher: AgentExecutionEventPublisher } {
  if (!params.clientEvents) {
    throw new Error("AgentExecutionService requires a durable client event publisher");
  }
  if (!params.outboxDispatcher) {
    throw new Error("AgentExecutionService requires an outbox dispatcher");
  }
  const statusTracker = new AgentExecutionStatusTracker();
  const eventPublisher = new AgentExecutionEventPublisher(params.clientEvents);
  const attachmentResolver = new AttachmentResolver(params.sessionFiles ?? null);
  const notificationQueue = params.notificationQueue ?? new SessionNotificationQueue();
  const storage = params.executionStorage;
  const slashCommandHandler = new SlashCommandHandler(
    params.tenantId,
    params.sessions,
    statusTracker,
    params.runtimeCore,
    params.providersProvider,
    params.compressionService ?? null,
    params.clientEvents,
  );
  const runEngine = new AgentRunEngine(
    params.tenantId,
    params.sessions,
    storage,
    params.dataRoot,
    params.getMemoryConfig,
    params.memoryContextSourceFactory ?? null,
   params.toolsDeps ?? null,
   params.codeExecutionTools ?? null,
   params.taskTools ?? null,
   params.providersProvider,
   params.backgroundTasks ?? null,
    notificationQueue,
    statusTracker,
    eventPublisher,
    params.permissionPolicy,
    params.pathAccessPolicyFactory,
    params.pendingInteractions,
    params.hostToolRegistry,
    params.delegationPending,
    params.logger ?? null,
    params.hooks ?? null,
    params.metricsCollector ?? null,
    params.compressionService ?? null,
  );
  const launchers = createLaunchers({
    tenantId: params.tenantId,
    sessions: params.sessions,
    runtimeCore: params.runtimeCore,
    slashCommandHandler,
    attachmentResolver,
    statusTracker,
    eventPublisher,
    runEngine,
    notificationQueue,
  });
  const sessionControl = createSessionControl({
    statusTracker,
    eventPublisher,
    pendingInteractions: params.pendingInteractions,
    runtimeStorage: params.runtimeStorage,
    clientEvents: params.clientEvents,
    executeSynchronously: launchers.executeSynchronously,
  });
  const query = createExecutionQueryService(statusTracker);
  return { ...launchers, ...sessionControl, ...query, runEngine, eventPublisher };
}
