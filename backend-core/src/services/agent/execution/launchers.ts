import { partsToPlainText } from "@ragsystem/agent-protocol";
import { randomUUID } from "node:crypto";

import type {
  AgentExecuteResult,
  AgentRunStartResult,
  AttachmentRef,
  ExecuteRequest,
  RollbackRetryStartResult,
  StreamExecuteRequest,
} from "../../../contracts/execution/execution.js";
import type { ThinkingLevel } from "@ragsystem/agent-llm";
import {
  toSessionIdentity,
  type MessageInfo,
  type SessionIdentity,
  type SessionOriginChannel,
} from "../../../contracts/session/session.js";
import { isRootUserRevisionAnchor } from "../../../contracts/session/message-visibility.js";
import type { ExecutionSessionPort } from "../../../contracts/session/session-application.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import { resolveExecutionAgentFor, type ReadinessResolution } from "./readiness.js";
import type { AttachmentResolver } from "./attachment-resolver.js";
import { createCommandRefPart, parseSlashCommand, type SlashCommandHandler } from "./slash-command-handler.js";
import type { AgentRunEngine } from "./run-engine.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { AgentExecutionEventPublisher } from "./event-publisher.js";
import type { MessageExtension } from "../context/extensions/kinds.js";
import { providerModelSupportsVision } from "../sdk/projection.js";
import type { TenantId } from "../../../identity/types.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import type { GoalStore } from "../../../contracts/runtime/goals.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { ExecutionResultReader } from "../../../contracts/execution/execution-storage.js";
import type {
  AgentMailboxStorePort,
  AgentMailboxWakeupTarget,
} from "../../../contracts/storage/agent-mailbox-repository.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { ExecutionAcceptedNotice, ExecutionStartOptions } from "../../../contracts/execution/execution-application.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type {
  AgentInvocationHandle,
  AgentInvocationPort,
  AgentInvocationRootInput,
} from "../../../contracts/execution/agent-invocation.js";
import type { ParticipantRunLifecyclePort } from "../delegation/port.js";
import type { UserMessageTransformInput } from "../../../plugins/backend-plugin.js";
import {
  mergeRequestOverrides,
  readSessionRequestOverrides,
  SESSION_REQUEST_OVERRIDES_METADATA_KEY,
  type SessionRequestOverrides,
} from "./session-request-overrides.js";
import {
  SessionMailboxConsumer,
  type AgentMailboxContinuationCompletionInput,
  type SessionMailboxLogger,
  type SessionSystemRunInput,
} from "./session-mailbox-consumer.js";

export {
  MAILBOX_CONTINUATION_REQUEST_PREFIX,
  mailboxContinuationSourceMessageId,
} from "./session-mailbox-consumer.js";
export type { AgentMailboxContinuationCompletionInput } from "./session-mailbox-consumer.js";

/** 用户消息持久化前变换管道（由容器组装闭包，注入 readAttachment/modelAdapter/systemConfig/clientEvents）。 */
export type UserMessageTransformRunner = (
  input: Omit<UserMessageTransformInput, "readAttachment" | "modelAdapter" | "systemConfig" | "clientEvents" | "pluginEvents">,
) => Promise<MessageContentPart[] | null>;

interface SendUserMessageInput {
  sessionId?: string | null;
  userId: string;
  requestId: string;
  task: string;
  attachments: AttachmentRef[];
  /**
   * 请求级模型选择（provider|provider_type|model 形态）。undefined = 继承会话设定；
   * null / 空串 = 显式清除（回落 agent tier 默认）；有值 = 本次生效并刷新设定。
   */
  selectedLlm?: string | null;
  /**
   * 请求级思考档位。undefined = 继承会话设定；null = 显式清除（跟随 tier 默认档位）；
   * 有值 = 本次生效并刷新设定。
   */
  thinkingLevel?: ThinkingLevel | null;
  executionKind: string;
  originChannel: SessionOriginChannel;
  uiContext?: Record<string, unknown> | null;
  agentName?: string | null;
  entrypoint?: string;
  messageMetadata?: Record<string, unknown>;
  traceMetadata?: Record<string, unknown>;
  sessionMaintenanceToken?: string;
  awaitFollowupCompletion?: boolean;
  followupPolicy: "queue" | "reject";
  onInteractionRequired?: ExecuteRequest["onInteractionRequired"];
  /** 提前确认（ExecutionStartOptions.onAccepted 透传）：耗时处理前恰好触发一次。 */
  onAccepted?: (notice: ExecutionAcceptedNotice) => void;
}

type SendUserMessageResult =
  | { kind: "error"; sessionId: string; error: string; runId?: string | null; taskId?: string | null }
  | { kind: "command"; sessionId: string; start: AgentRunStartResult; success: boolean; content: string; contentParts: MessageContentPart[] }
  | { kind: "run"; sessionId: string; agentName: string; handle: AgentInvocationHandle };

export interface RollbackRetryInput {
  sessionId: string;
  userId: string;
  requestId: string;
  afterSeq?: number | null;
  afterMessageId?: string | null;
  modifyUserMessage?: string | null;
  selectedLlm?: string | null;
  /** 请求级思考档位（前端 thinking_level）；undefined = 跟随 agent tier 默认档位。 */
  thinkingLevel?: ThinkingLevel | null;
  attachments?: AttachmentRef[] | null;
  uiContext?: Record<string, unknown> | null;
}

export interface LauncherApi {
  startStream(request: StreamExecuteRequest, requestId: string, options?: ExecutionStartOptions): Promise<AgentRunStartResult>;
  executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult>;
  /** 独立会话操作（/rollback）的忙判定：与 startRollbackRetry 同一口径（运行中或 durable 活跃 run）。 */
  isSessionBusy(sessionId: string): Promise<boolean>;
  /** Session idle 检查：消费后台通知，并在 Goal active 时拉起 continuation run。 */
  triggerBgNotificationRun(sessionId: string): void;
  triggerAgentMailboxRun(target: AgentMailboxWakeupTarget): void;
  completeAgentMailboxContinuation(input: AgentMailboxContinuationCompletionInput): Promise<void>;
}

export interface LauncherDeps {
  tenantId: TenantId;
  sessions: ExecutionSessionPort;
  runtimeCore: RuntimeExecutionConfigResolver;
  slashCommandHandler: SlashCommandHandler;
  attachmentResolver: AttachmentResolver;
  statusTracker: AgentExecutionStatusTracker;
  eventPublisher: AgentExecutionEventPublisher;
  runEngine: AgentRunEngine;
  invocationService: AgentInvocationPort;
  backgroundTasks: BackgroundTaskService | null;
  goalStore: GoalStore | null;
  runtimeStorage: RuntimeStorage;
  clientEvents: ClientEventPublisher;
  mailbox?: AgentMailboxStorePort | null;
  runReader?: Pick<ExecutionResultReader, "getRun"> & Partial<Pick<ExecutionResultReader, "getMessageById" | "listRuns">>;
  participantRuns: ParticipantRunLifecyclePort;
  transformUserMessage?: UserMessageTransformRunner | null;
  /** 消费组件错误日志出口（缺省 console.error）；组合层可注入自身 logger。 */
  logger?: SessionMailboxLogger | null;
}

/**
 * 会话 metadata 键：主智能体 default 档的当前设定（selected_llm / thinking_level，
 * 字段 null = 未设定）。前端选择器变化即时 PATCH 本键，发送路径后端补写实际生效值；
 * 一切主智能体 root run 拉起渠道经 readSessionRequestOverrides 读回（详见
 * session-request-overrides.ts）。
 */
export { SESSION_REQUEST_OVERRIDES_METADATA_KEY };

/**
 * 执行启动适配层：用户消息唯一流水线（sendUserMessage）+ 协议返回形状适配。
 * Agent 解析唯一经 resolveExecutionAgent，root invoke 唯一经 invokeRootRun；
 * mailbox 消费整体委托 SessionMailboxConsumer（经 launchSystemRun 钩子回到唯一组装点）。
 */
class AgentLaunchers {
  constructor(
    private readonly tenantId: TenantId,
    private readonly sessions: ExecutionSessionPort,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly slashCommandHandler: SlashCommandHandler,
    private readonly attachmentResolver: AttachmentResolver,
    private readonly statusTracker: AgentExecutionStatusTracker,
    private readonly eventPublisher: AgentExecutionEventPublisher,
    private readonly runEngine: AgentRunEngine,
    private readonly invocationService: AgentInvocationPort,
    private readonly backgroundTasks: BackgroundTaskService | null,
    private readonly runtimeStorage: RuntimeStorage,
    private readonly clientEvents: ClientEventPublisher,
    private readonly transformUserMessage: UserMessageTransformRunner | null,
  ) {}

  private async durableActiveRunId(sessionId: string): Promise<string | null> {
    return (await this.runtimeStorage.operations.getActiveRootRun?.(sessionId))?.runId ?? null;
  }

  /**
   * 一切 root run 的唯一 invoke 组装点：用户发送（foreground + user_message 持久化）、
   * 系统渠道（background + mailbox 引用）与 mailbox root 续跑（确定性 runId/taskId/
   * rootCallId + mailbox 目标透传）只差参数。background 系统触发在终态后统一
   * scheduleAutoTrigger；readiness 由调用方经 resolveExecutionAgentFor 解析后传入。
   */
  private invokeRootRun(input: {
    sessionIdentity: SessionIdentity;
    userId: string | null;
    requestId: string;
    task: string;
    executionKind: string;
    ready: Extract<ReadinessResolution, { ok: true }>;
    overrides: SessionRequestOverrides;
    execution: "foreground" | "background";
    modelTask?: string;
    entrypoint?: string;
    runId?: string;
    taskId?: string;
    rootCallId?: string;
    persistUserMessage?: AgentInvocationRootInput["persistUserMessage"];
    rootMailboxMessage?: AgentInvocationRootInput["rootMailboxMessage"];
    traceMetadata?: Record<string, unknown>;
    onInteractionRequired?: ExecuteRequest["onInteractionRequired"];
    sessionMaintenanceToken?: string;
    awaitFollowupCompletion?: boolean;
    followupPolicy?: "queue" | "reject";
  }): AgentInvocationHandle {
    const started = this.invocationService.invoke({
      scope: "root",
      mode: "create",
      execution: input.execution,
      sessionId: input.sessionIdentity.sessionId,
      sessionIdentity: input.sessionIdentity,
      userId: input.userId,
      requestId: input.requestId,
      task: input.task,
      ...(input.modelTask ? { modelTask: input.modelTask } : {}),
      executionKind: input.executionKind,
      ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.rootCallId ? { rootCallId: input.rootCallId } : {}),
      agent: input.ready.agent,
      provider: input.ready.provider,
      modelName: input.ready.modelName,
      ...(input.overrides.selectedLlm
        ? { selectedLlm: { provider: input.ready.provider, modelName: input.ready.modelName } }
        : {}),
      ...(input.overrides.thinkingLevel ? { thinkingLevel: input.overrides.thinkingLevel } : {}),
      ...(input.persistUserMessage ? { persistUserMessage: input.persistUserMessage } : {}),
      ...(input.rootMailboxMessage ? { rootMailboxMessage: input.rootMailboxMessage } : {}),
      ...(input.traceMetadata
        ? {
          startStepExtra: input.traceMetadata,
          runStartExtra: input.traceMetadata,
          finalMetadataExtra: input.traceMetadata,
        }
        : {}),
      ...(input.onInteractionRequired ? { onInteractionRequired: input.onInteractionRequired } : {}),
      ...(input.sessionMaintenanceToken ? { sessionMaintenanceToken: input.sessionMaintenanceToken } : {}),
      ...(input.awaitFollowupCompletion ? { awaitFollowupCompletion: true } : {}),
      followupPolicy: input.followupPolicy ?? "queue",
    });
    if (input.execution === "background") {
      void started.promise.finally(() => {
        this.backgroundTasks?.scheduleAutoTrigger(input.sessionIdentity.sessionId);
      }).catch(() => undefined);
    }
    return started;
  }

  private async waitForRunResult(
    sessionId: string,
    started: { agentName: string; handle: AgentInvocationHandle },
  ): Promise<AgentExecuteResult> {
    const outcome = await started.handle.promise;
    return this.runEngine.buildSynchronousResult({
      sessionId,
      runId: outcome.runId ?? started.handle.run_id ?? null,
      taskId: started.handle.task_id ?? null,
      agentName: started.agentName,
      outcome,
    });
  }

  /** 所有外部用户消息的唯一处理入口；各通道只适配启动确认或最终结果。 */
  private async sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult> {
    const sessionId = input.sessionId?.trim() || randomUUID();
    const task = input.task.trim();
    const slashCommand = parseSlashCommand(task);
    const existingSession = await this.sessions.getSession(sessionId);
    const sessionIdentity: SessionIdentity = existingSession
      ? toSessionIdentity(existingSession)
      : {
          sessionId,
          ownerUserId: input.userId,
          visibility: "private",
          originType: "direct",
          originId: null,
          originChannel: input.originChannel,
          workspaceId: null,
          teamSnapshot: this.runtimeCore.createTeamSnapshot(),
          metadata: {},
          permissionMode: null,
        };

    // 会话级设定合并：请求未携带（undefined）→ 继承会话当前设定；显式 null → 清除；
    // 有值 → 生效。effective 即本次执行口径，也是 metadata 回写值——继承时写回原值
    // 保持设定不动，清除时写 null，与"会话实际执行口径"始终一致。
    const overrides: SessionRequestOverrides = mergeRequestOverrides(
      { selectedLlm: input.selectedLlm, thinkingLevel: input.thinkingLevel },
      existingSession ? readSessionRequestOverrides(existingSession.metadata) : { selectedLlm: null, thinkingLevel: null },
    );
    const effectiveSelectedLlm = overrides.selectedLlm ?? "";

    if (slashCommand) {
      const commandResult = await this.slashCommandHandler.handle({
        sessionId,
        sessionIdentity,
        userId: input.userId,
        requestId: input.requestId,
        selectedLlm: effectiveSelectedLlm,
        command: slashCommand,
        originalTask: task,
        ...(input.messageMetadata ? { messageMetadata: input.messageMetadata } : {}),
        ...(input.sessionMaintenanceToken ? { sessionMaintenanceToken: input.sessionMaintenanceToken } : {}),
      });
      if (commandResult) {
        // 命令路径不涉及插件变换：确认时机与原来一致（命令处理完成后）。
        input.onAccepted?.({ kind: "command" });
        return {
          kind: "command",
          sessionId,
          start: commandResult.start,
          success: commandResult.success,
          content: commandResult.content,
          contentParts: commandResult.contentParts,
        };
      }
    }

    if (!task && input.attachments.length === 0) {
      return { kind: "error", sessionId, error: "Task and attachments cannot both be empty" };
    }

    if (input.followupPolicy === "reject" || input.attachments.length > 0) {
      const runningStatus = this.statusTracker.getStatusBySession(sessionId);
      const durableRunId = await this.durableActiveRunId(sessionId);
      if (runningStatus?.status === "running" || durableRunId) {
        if (input.attachments.length > 0 && input.followupPolicy === "queue") {
          return {
            kind: "error",
            sessionId,
            runId: runningStatus?.run_id ?? durableRunId,
            taskId: runningStatus?.task_id ?? null,
            error: "运行中的补充消息暂不支持附件，请等待当前任务结束后重新发送",
          };
        }
        return {
          kind: "error",
          sessionId,
          runId: runningStatus?.run_id ?? durableRunId,
          taskId: runningStatus?.task_id ?? null,
          error: "该会话正在执行任务，请等待完成或停止当前任务",
        };
      }
    }

    // 提前确认点：基础校验已通过，其后的附件解析/插件变换/落库/启动均为耗时处理——
    // realtime 通道经 onAccepted 立即回 phase=received 的 ACK，与插件变换耗时解耦；
    // 此点之后的失败由调用方以 error 帧补偿（携带 request_id）。
    input.onAccepted?.({});

    const attachmentResolution = await this.attachmentResolver.resolve(sessionId, input.attachments);
    if (attachmentResolution.error) {
      return { kind: "error", sessionId, error: attachmentResolution.error };
    }

    const extensions: MessageExtension[] = [];
    if (input.uiContext) extensions.push({ kind: "ui_context", data: input.uiContext });
    const contentParts: MessageContentPart[] = [
      ...(slashCommand
        ? [createCommandRefPart(slashCommand, task)]
        : task ? [{ type: "text" as const, text: task }] : []),
      ...attachmentResolution.attachments.map((attachment): MessageContentPart => ({
        type: "attachment_ref",
        file_id: attachment.file_id,
        original_name: attachment.original_name,
        stored_name: attachment.stored_name,
        mime: attachment.mime,
        size: attachment.size,
        kind: attachment.kind,
        presentation: attachment.kind === "image" ? "inline" : "attachment",
        ...(attachment.file_path ? { file_path: attachment.file_path } : {}),
        ...(attachment.file_path_space ? { file_path_space: attachment.file_path_space } : {}),
      })),
    ];

    // 持久化前变换：插件管道可在写入前改写 contentParts（如为图片附件追加视觉描述）。
    // ACK 已在此前前置（onAccepted），变换耗时不阻塞确认；单图耗时由插件自身超时约束
    // （image_tools.timeout_seconds 默认 60s）；失败回退原始 parts。
    // 执行 Agent 在此解析一次、贯穿后续变换与 invoke（多模态模型直接看原图，插件跳过
    // 冗余的视觉辅助描述；解析失败不传标志，transformer 保持原行为）。视觉能力按模型
    // 条目 input_modalities 派生（与执行期 profile 投影同源）——原始 provider 不承载
    // supports_vision（水合剥离的废弃字段）。
    const ready = resolveExecutionAgentFor(this.runtimeCore, {
      ...(input.agentName ? { agentName: input.agentName } : {}),
      teamSnapshot: sessionIdentity.teamSnapshot,
      selectedLlm: overrides.selectedLlm,
    });
    if (!ready.ok) {
      return { kind: "error", sessionId, error: ready.reason };
    }
    const persistedContentParts = this.transformUserMessage
      ? (await this.transformUserMessage({
          sessionId,
          tenantId: this.tenantId,
          contentParts,
          attachments: attachmentResolution.attachments,
          mainModelSupportsVision: providerModelSupportsVision(
            ready.provider,
            ready.modelName,
          ),
        })) ?? contentParts
      : contentParts;

    const handle = this.invokeRootRun({
      sessionIdentity,
      userId: input.userId,
      requestId: input.requestId,
      task,
      executionKind: input.executionKind,
      ready,
      overrides,
      execution: "foreground",
      ...(slashCommand?.mode === "prompt" ? { modelTask: slashCommand.agentText } : {}),
      ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
      persistUserMessage: {
        metadata: {
          ...(input.messageMetadata ?? {}),
          ...(extensions.length ? { extensions } : {}),
        },
        contentParts: persistedContentParts,
        inputType: "user_message",
        sourceKind: "user",
        visibleToUser: true,
      },
      ...(input.traceMetadata ? { traceMetadata: input.traceMetadata } : {}),
      ...(input.sessionMaintenanceToken ? { sessionMaintenanceToken: input.sessionMaintenanceToken } : {}),
      ...(input.awaitFollowupCompletion ? { awaitFollowupCompletion: true } : {}),
      followupPolicy: input.followupPolicy,
      ...(input.onInteractionRequired ? { onInteractionRequired: input.onInteractionRequired } : {}),
    });
    // 覆盖记录挂在 durableStarted 之后（新会话行此刻已持久化）；写入失败静默——
    // 丢的只是恢复回显线索，不应影响发送主流程。写的是合并后的实际生效值
    // （继承时写回原值、清除时写 null），会话设定与执行口径始终一致。
    void handle.durableStarted
      .then(() => this.sessions.updateSessionMetadata(sessionId, {
        [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: {
          selected_llm: overrides.selectedLlm,
          thinking_level: overrides.thinkingLevel,
          updated_at: new Date().toISOString(),
        },
      }))
      .catch(() => undefined);
    return { kind: "run", sessionId, agentName: ready.agent.agent_name, handle };
  }

  async startStream(
    request: StreamExecuteRequest,
    requestId: string,
    options: ExecutionStartOptions = {},
  ): Promise<AgentRunStartResult> {
    const submitted = await this.sendUserMessage({
      ...(request.session_id !== undefined ? { sessionId: request.session_id } : {}),
      userId: request.userId,
      requestId,
      task: request.task,
      attachments: request.attachments,
      executionKind: "agent_stream",
      originChannel: "web",
      ...(request.selected_llm !== undefined ? { selectedLlm: request.selected_llm } : {}),
      ...(request.thinking_level !== undefined ? { thinkingLevel: request.thinking_level } : {}),
      ...(request.ui_context !== undefined ? { uiContext: request.ui_context } : {}),
      followupPolicy: options.followupPolicy ?? "queue",
      ...(options.onAccepted ? { onAccepted: options.onAccepted } : {}),
    });
    if (submitted.kind === "error") {
      return { started: false, session_id: submitted.sessionId, error: submitted.error };
    }
    if (submitted.kind === "command") {
      return {
        ...submitted.start,
        command_result: { success: submitted.success, content: submitted.content },
      };
    }

    const { promise: _promise, durableStarted, ...publicStarted } = submitted.handle;
    try {
      const disposition = await durableStarted;
      if (disposition.kind === "followup") {
        if (disposition.queueAccepted === false) {
          return {
            ...publicStarted,
            started: false,
            run_id: disposition.activeRunId,
            error: "该会话正在其他实例执行任务，请等待完成后重试",
          };
        }
        return {
          started: true,
          session_id: submitted.sessionId,
          run_id: disposition.activeRunId,
          request_id: requestId,
          kind: "agent_run",
        };
      }
      return publicStarted;
    } catch (error) {
      return {
        ...publicStarted,
        started: false,
        error: error instanceof Error ? error.message : "Run failed before durable start",
      };
    }
  }

  async executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult> {
    const executionKind = request.executionKind?.trim() || "execute";
    const submitted = await this.sendUserMessage({
      ...(request.session_id !== undefined ? { sessionId: request.session_id } : {}),
      userId: request.userId,
      requestId,
      task: request.task,
      attachments: [],
      executionKind,
      originChannel: "api",
      ...(request.selected_llm !== undefined ? { selectedLlm: request.selected_llm } : {}),
      ...(request.thinking_level !== undefined ? { thinkingLevel: request.thinking_level } : {}),
      ...(request.agent ? { agentName: request.agent } : {}),
      entrypoint: "execute",
      followupPolicy: "queue",
      awaitFollowupCompletion: true,
      ...(request.onInteractionRequired ? { onInteractionRequired: request.onInteractionRequired } : {}),
    });
    if (submitted.kind === "error") {
      return {
        success: false,
        answer: null,
        content_parts: [],
        agent_name: null,
        execution_time: null,
        tool_calls: [],
        metadata: {},
        session_id: submitted.sessionId,
        run_id: submitted.runId ?? null,
        task_id: submitted.taskId ?? null,
        error: submitted.error,
      };
    }
    if (submitted.kind === "command") {
      return {
        success: submitted.success,
        answer: submitted.content,
        content_parts: submitted.contentParts,
        agent_name: null,
        execution_time: 0,
        tool_calls: [],
        metadata: { command: true },
        session_id: submitted.sessionId,
        run_id: null,
        task_id: null,
        error: submitted.success ? null : submitted.content,
      };
    }

    try {
      const disposition = await submitted.handle.durableStarted;
      if (disposition.kind === "followup") {
        const accepted = disposition.queueAccepted !== false;
        if (!accepted) {
          return {
            success: false,
            answer: null,
            content_parts: [],
            agent_name: submitted.agentName,
            execution_time: null,
            tool_calls: [],
            metadata: {},
            session_id: submitted.sessionId,
            run_id: disposition.activeRunId,
            task_id: null,
            error: "该会话正在其他实例执行任务，请等待完成后重试",
          };
        }
      }
    } catch (error) {
      return {
        success: false,
        answer: null,
        content_parts: [],
        agent_name: submitted.agentName,
        execution_time: null,
        tool_calls: [],
        metadata: {},
        session_id: submitted.sessionId,
        run_id: submitted.handle.run_id ?? null,
        task_id: submitted.handle.task_id ?? null,
        error: error instanceof Error ? error.message : "Run failed before durable start",
      };
    }
    return this.waitForRunResult(submitted.sessionId, {
      agentName: submitted.agentName,
      handle: submitted.handle,
    });
  }

  /**
   * 独立会话操作（/rollback 消息回退）的忙判定：与 startRollbackRetry 同一口径——
   * 本实例运行中 run 或 durable 活跃 run 任一命中即忙。活跃 run 中途回退会在运行中的
   * agent 脚下删消息、回滚文件（并发 trackEdit 与 restore 互踩），必须拒绝。
   */
  async isSessionBusy(sessionId: string): Promise<boolean> {
    const normalized = sessionId.trim();
    if (!normalized) {
      return false;
    }
    const runningStatus = this.statusTracker.getStatusBySession(normalized);
    const durableRunId = await this.durableActiveRunId(normalized);
    return runningStatus?.status === "running" || durableRunId != null;
  }

  async startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      return {
        started: false,
        session_id: input.sessionId,
        deleted: 0,
        error: "session_id is required",
      };
    }
    if (input.afterSeq == null && !input.afterMessageId?.trim()) {
      return {
        started: false,
        session_id: sessionId,
        deleted: 0,
        error: "请提供 after_seq 或 after_message_id",
      };
    }
    const runningStatus = this.statusTracker.getStatusBySession(sessionId);
    const durableRunId = await this.durableActiveRunId(sessionId);
    if (runningStatus?.status === "running" || durableRunId) {
      return {
        started: false,
        session_id: sessionId,
        deleted: 0,
        error: "该会话正在执行任务，请等待完成或停止当前任务",
      };
    }

    const retryMessage = await this.sessions.getMessageForRetry({
      sessionId,
      ...(input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : {}),
      ...(input.afterMessageId !== undefined ? { afterMessageId: input.afterMessageId } : {}),
    });
    if (!retryMessage) {
      return { started: false, session_id: sessionId, deleted: 0, error: "未找到要重试的用户消息" };
    }
    if (!isRootUserRevisionAnchor(retryMessage)) {
      return { started: false, session_id: sessionId, deleted: 0, error: "只能从根会话中的用户消息重试" };
    }
    const task = input.modifyUserMessage?.trim() || partsToPlainText(retryMessage.content_parts).trim();
    if (!task) {
      return { started: false, session_id: sessionId, deleted: 0, error: "无法获取要重试的任务内容" };
    }

    const attachments = input.attachments ?? extractMessageAttachments(retryMessage);
    const uiContext = input.uiContext === undefined
      ? extractMessageUiContext(retryMessage)
      : input.uiContext;
    const traceMetadata = {
      retry_of_seq: retryMessage.seq,
      retry_of_message_id: retryMessage.id,
    };

    // 维护租约 kind 是前端刷新恢复的事实源（maintenance·compact → "正在压缩…"横线/呼吸点/
    // 胶囊文案派生）：回滚入口重发 /compact 时整个压缩都跑在本租约下（slash handler 只续租
    // 不改 kind），必须按实际操作标 compact，否则刷新后派生不命中。
    const maintenanceKind = parseSlashCommand(task)?.name === "compact" ? "compact" : "rollback";
    const maintenanceToken = randomUUID();
    const maintenanceTtlMs = 60_000;
    const maintenance = await this.runtimeStorage.operations.claimSessionMaintenance({
      sessionId,
      token: maintenanceToken,
      kind: maintenanceKind,
      ttlMs: maintenanceTtlMs,
    });
    if (!maintenance.claimed) {
      return {
        started: false,
        session_id: sessionId,
        deleted: 0,
        error: "该会话正在执行任务，请等待完成或停止当前任务",
      };
    }
    await this.publishRuntimeInvalidation(sessionId, "maintenance_claimed");

    let maintenanceLost = false;
    const maintenanceHeartbeat = setInterval(() => {
      void this.runtimeStorage.operations.renewSessionMaintenance({
        sessionId,
        token: maintenanceToken,
        ttlMs: maintenanceTtlMs,
      }).then((renewed) => {
        if (!renewed) maintenanceLost = true;
      }, () => {
        maintenanceLost = true;
      });
    }, 20_000);
    maintenanceHeartbeat.unref?.();

    try {
      // 回滚是独立会话操作：删除目标用户消息及其后的内容，再从统一用户消息入口重新发送。
      const deleted = await this.sessions.rollbackMessages({
        sessionId,
        afterSeq: retryMessage.seq - 1,
      });
      if (maintenanceLost || !await this.runtimeStorage.operations.renewSessionMaintenance({
        sessionId,
        token: maintenanceToken,
        ttlMs: maintenanceTtlMs,
      })) {
        return {
          started: false,
          session_id: sessionId,
          deleted,
          error: "会话维护租约已丢失，回滚完成但未继续启动重试",
        };
      }
      const submitted = await this.sendUserMessage({
        sessionId,
        userId: input.userId,
        requestId: input.requestId,
        task,
        attachments,
        ...(input.selectedLlm !== undefined ? { selectedLlm: input.selectedLlm } : {}),
        ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
        executionKind: "rollback_and_retry",
        originChannel: "web",
        entrypoint: "rollback_and_retry",
        uiContext,
        messageMetadata: {
          ...traceMetadata,
          ...(input.modifyUserMessage?.trim() ? { retry_modified_at: new Date().toISOString() } : {}),
        },
        traceMetadata,
        followupPolicy: "reject",
        sessionMaintenanceToken: maintenanceToken,
      });
      if (submitted.kind === "error") {
        return {
          started: false,
          session_id: submitted.sessionId,
          deleted,
          error: submitted.error,
        };
      }
      if (submitted.kind === "command") {
        return {
          ...submitted.start,
          deleted,
          command_result: { success: submitted.success, content: submitted.content },
          // 命令失败（含用户主动停止压缩）时把真实文案带给路由层：否则 400 兜底成
          // "重试启动失败"，前端 toast 与消息流里的 command_result 文案对不上。
          ...(submitted.success ? {} : { error: submitted.content || "命令执行失败" }),
        };
      }

      const { promise: _promise, durableStarted, ...publicStarted } = submitted.handle;
      try {
        const disposition = await durableStarted;
        if (disposition.kind === "followup") {
          return {
            started: false,
            session_id: submitted.sessionId,
            run_id: disposition.activeRunId,
            request_id: input.requestId,
            kind: "agent_run",
            deleted,
            error: disposition.queueAccepted === false
              ? "该会话正在其他实例执行任务，请等待完成后重试"
              : "该会话正在执行任务，重试消息已进入后续队列",
          };
        }
      } catch (error) {
        return {
          ...publicStarted,
          started: false,
          deleted,
          agent_name: submitted.agentName,
          error: error instanceof Error ? error.message : "Run failed before durable start",
        };
      }

      return {
        ...publicStarted,
        deleted,
        agent_name: submitted.agentName,
      };
    } finally {
      clearInterval(maintenanceHeartbeat);
      await this.runtimeStorage.operations.releaseSessionMaintenance({ sessionId, token: maintenanceToken });
      await this.publishRuntimeInvalidation(sessionId, "maintenance_released");
    }
  }

  private publishRuntimeInvalidation(sessionId: string, reason: string): Promise<unknown> {
    return this.clientEvents.publish(sessionId, {
      type: "state_sync",
      session_id: sessionId,
      payload: { category: "session_updated", detail: { entity: "session_runtime", reason } },
    }, {
      aggregateType: "session",
      aggregateId: sessionId,
    });
  }

  /** 消费组件注入的系统 run 拉起钩子：经唯一组装点 invokeRootRun 以 background 执行。 */
  launchSystemRun(input: SessionSystemRunInput): AgentInvocationHandle {
    return this.invokeRootRun({ ...input, execution: "background" });
  }
}

function extractMessageAttachments(message: MessageInfo): AttachmentRef[] {
  return message.content_parts
    .filter((part) => part.type === "attachment_ref")
    .map((part) => ({ file_id: part.file_id }));
}

function extractMessageUiContext(message: MessageInfo): Record<string, unknown> | null {
  const extensions = Array.isArray(message.metadata.extensions) ? message.metadata.extensions : [];
  for (const extension of extensions) {
    if (isRecord(extension) && extension.kind === "ui_context" && isRecord(extension.data)) {
      return extension.data;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createLaunchers(deps: LauncherDeps): LauncherApi {
  const impl = new AgentLaunchers(
    deps.tenantId,
    deps.sessions,
    deps.runtimeCore,
    deps.slashCommandHandler,
    deps.attachmentResolver,
    deps.statusTracker,
    deps.eventPublisher,
    deps.runEngine,
    deps.invocationService,
    deps.backgroundTasks,
    deps.runtimeStorage,
    deps.clientEvents,
    deps.transformUserMessage ?? null,
  );
  const mailboxConsumer = new SessionMailboxConsumer({
    tenantId: deps.tenantId,
    sessions: deps.sessions,
    runtimeCore: deps.runtimeCore,
    statusTracker: deps.statusTracker,
    invocationService: deps.invocationService,
    backgroundTasks: deps.backgroundTasks,
    goalStore: deps.goalStore,
    runtimeStorage: deps.runtimeStorage,
    mailbox: deps.mailbox ?? null,
    runReader: deps.runReader ?? null,
    participantRuns: deps.participantRuns,
    launchSystemRun: (input) => impl.launchSystemRun(input),
    logger: deps.logger ?? null,
  });
  return {
    startStream: impl.startStream.bind(impl),
    executeSynchronously: impl.executeSynchronously.bind(impl),
    startRollbackRetry: impl.startRollbackRetry.bind(impl),
    isSessionBusy: impl.isSessionBusy.bind(impl),
    triggerBgNotificationRun: (sessionId) => mailboxConsumer.triggerBgNotificationRun(sessionId),
    triggerAgentMailboxRun: (target) => mailboxConsumer.triggerAgentMailboxRun(target),
    completeAgentMailboxContinuation: (input) => mailboxConsumer.completeAgentMailboxContinuation(input),
  };
}
