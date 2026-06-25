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
} from "../../../contracts/execution.js";
import type { AgentContextService } from "../context/index.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { AgentPromptConfigResolver } from "../prompt-builder/index.js";
import type { LlmChatClient } from "../../integrations/llm-chat-client.js";
import type { AgentSessionApplication } from "../../sessions/index.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import type { DurableClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { OutboxDispatcher } from "../../runtime/event-outbox/dispatcher.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import type { TaskToolService } from "../../../tools/TaskTools/TaskExecution.js";
import type { PermissionPolicyService } from "../../runtime/permission-policy-service.js";
import type { PendingInteractionService } from "../../runtime/pending-interaction-service.js";
import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import type { IFileIndexStore } from "../../../contracts/file-index-store/index.js";
import { AgentExecutionEventPublisher } from "./event-publisher.js";
import { AgentExecutionStatusTracker } from "./status-tracker.js";
import { AttachmentResolver } from "./attachment-resolver.js";
import { SlashCommandHandler } from "./slash-command-handler.js";
import { AgentRunEngine, type AgentExecutionLogger } from "./run-engine.js";
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
  sessions: AgentSessionApplication;
  conversationStore: ConversationStore;
  runtimeCore: RuntimeExecutionConfigResolver;
  llmChatClient: LlmChatClient;
  dataRoot: string;
  contextService: AgentContextService;
  /** per-agent 工具依赖（runtime-adapter per-run 构建 Tool[] 用）。 */
  toolsDeps?: Omit<import("../../../tools/registry.js").BackendToolsDeps, "agent" | "teamName"> | null;
  codeExecutionTools?: import("../../../tools/CodeExecutionTool/CodeExecution.js").CodeExecutionToolService | null;
  taskTools?: TaskToolService | null;
  promptConfigResolver?: AgentPromptConfigResolver | null;
  backgroundTasks?: BackgroundTaskService | null;
  fileIndex?: IFileIndexStore | null;
  outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">;
 clientEvents: DurableClientEventPublisher;
 /** 已加载的 provider 列表提供者（SDK 投影层解析 tier.provider 引用用）。 */
 providersProvider: () => ModelProviderConfig[];
 /** 权限策略服务（SDK 审批编排判定用）。 */
 permissionPolicy: PermissionPolicyService;
 /** 审批交互服务（SDK 审批编排阻塞等待用）。 */
 pendingInteractions: PendingInteractionService;
 logger?: AgentExecutionLogger | null | undefined;
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
  const eventPublisher = new AgentExecutionEventPublisher(
    params.sessions,
    params.clientEvents,
    params.conversationStore,
  );
  const attachmentResolver = new AttachmentResolver(params.fileIndex ?? null);
  const slashCommandHandler = new SlashCommandHandler(
    params.sessions,
    statusTracker,
    params.runtimeCore,
    params.contextService,
    params.clientEvents,
  );
  const runEngine = new AgentRunEngine(
    params.sessions,
    params.conversationStore,
    params.llmChatClient,
    params.dataRoot,
   params.toolsDeps ?? null,
   params.codeExecutionTools ?? null,
   params.taskTools ?? null,
   params.promptConfigResolver ?? null,
   params.providersProvider,
   params.backgroundTasks ?? null,
    statusTracker,
    eventPublisher,
    params.outboxDispatcher,
    params.clientEvents,
    params.permissionPolicy,
    params.pendingInteractions,
    params.logger ?? null,
  );
  const launchers = createLaunchers({
    sessions: params.sessions,
    conversationStore: params.conversationStore,
    runtimeCore: params.runtimeCore,
    slashCommandHandler,
    attachmentResolver,
    statusTracker,
    eventPublisher,
    runEngine,
  });
  const sessionControl = createSessionControl({
    statusTracker,
    eventPublisher,
    executeSynchronously: launchers.executeSynchronously,
  });
  const query = createExecutionQueryService(statusTracker);
  return { ...launchers, ...sessionControl, ...query, runEngine, eventPublisher };
}
