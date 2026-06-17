import type {
  AgentExecuteResult,
  AgentRunStartResult,
  CheckpointRecoveryStartResult,
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
import type { AgentContextCompressionService } from "../agent-context-compression-service.js";
import type { AgentPromptConfigResolver } from "../agent-prompt-builder.js";
import type { AgentRuntimeContextBuilder } from "../agent-runtime-context-builder.js";
import type { AgentRuntimeCore } from "../agent-runtime-core.js";
import type { AgentSessionApplication } from "../agent-session-application.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import type { DurableClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { OutboxDispatcher } from "../../runtime/event-outbox/dispatcher.js";
import type { RuntimeExecutionConfigResolver } from "../../runtime/runtime-core-service.js";
import type { RuntimeToolExecutor } from "../../runtime/runtime-tool-types.js";
import type { ConversationStore } from "../../stores/conversation-store/index.js";
import type { FileIndexService } from "../../stores/file-index-service.js";
import { AgentExecutionEventPublisher } from "./event-publisher.js";
import { ExecutionRecorder } from "./recorder.js";
import { AgentExecutionStatusTracker } from "./status-tracker.js";
import { AttachmentResolver } from "./attachment-resolver.js";
import { SlashCommandHandler } from "./slash-command-handler.js";
import { FollowupQueue } from "./followup-queue.js";
import { AgentRunEngine, type AgentExecutionLogger } from "./run-engine.js";
import {
  createLaunchers,
  type CheckpointRecoveryInput,
  type RollbackRetryInput,
} from "./launchers.js";
import { createSessionControl } from "./session-control.js";
import { createExecutionQueryService } from "./query.js";

export type { AgentExecutionLogger } from "./run-engine.js";
export type { RollbackRetryInput, CheckpointRecoveryInput } from "./launchers.js";

export interface AgentExecutionServiceApi {
  startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult>;
  executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  collaborateSequentially(
    request: CollaborateRequest,
    requestId: string,
  ): Promise<{ results: AgentExecuteResult[]; session_id: string; total_tasks: number }>;
  startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult>;
  startCheckpointRecovery(input: CheckpointRecoveryInput): Promise<CheckpointRecoveryStartResult>;
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
  agentRuntimeCore: AgentRuntimeCore;
  contextBuilder: AgentRuntimeContextBuilder;
  runtimeTools?: RuntimeToolExecutor | null;
  contextCompression?: AgentContextCompressionService | null;
  promptConfigResolver?: AgentPromptConfigResolver | null;
  backgroundTasks?: BackgroundTaskService | null;
  fileIndex?: FileIndexService | null;
  outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">;
  clientEvents: DurableClientEventPublisher;
  logger?: AgentExecutionLogger | null | undefined;
}

/**
 * 组装 agent 执行服务（无主类）：创建共享实例（statusTracker/followupQueue/eventPublisher/...）
 * + runEngine + slash/attachment handler，组合 launchers/sessionControl/query 为统一 Api。
 * 类比 tools 的 createXxxTools(deps) 工厂。
 */
export function createAgentExecutionService(params: AgentExecutionServiceParams): AgentExecutionServiceApi {
  if (!params.clientEvents) {
    throw new Error("AgentExecutionService requires a durable client event publisher");
  }
  if (!params.outboxDispatcher) {
    throw new Error("AgentExecutionService requires an outbox dispatcher");
  }
  const statusTracker = new AgentExecutionStatusTracker();
  const followupQueue = new FollowupQueue();
  const eventPublisher = new AgentExecutionEventPublisher(
    params.sessions,
    params.clientEvents,
    params.conversationStore,
  );
  const executionRecorder = new ExecutionRecorder(params.conversationStore);
  const attachmentResolver = new AttachmentResolver(params.fileIndex ?? null);
  const slashCommandHandler = new SlashCommandHandler(
    params.sessions,
    statusTracker,
    params.runtimeCore,
    params.contextCompression ?? null,
    params.contextBuilder,
    params.clientEvents,
  );
  const runEngine = new AgentRunEngine(
    params.sessions,
    params.conversationStore,
    params.agentRuntimeCore,
    params.contextBuilder,
    params.runtimeTools ?? null,
    params.contextCompression ?? null,
    params.promptConfigResolver ?? null,
    params.backgroundTasks ?? null,
    statusTracker,
    eventPublisher,
    executionRecorder,
    params.outboxDispatcher,
    params.clientEvents,
    params.logger ?? null,
  );
  const launchers = createLaunchers({
    sessions: params.sessions,
    conversationStore: params.conversationStore,
    runtimeCore: params.runtimeCore,
    contextBuilder: params.contextBuilder,
    slashCommandHandler,
    attachmentResolver,
    followupQueue,
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
  return { ...launchers, ...sessionControl, ...query };
}
