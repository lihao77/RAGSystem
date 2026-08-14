import { createHash, randomUUID } from "node:crypto";

import type {
  AgentExecuteResult,
  AgentRunStartResult,
  AttachmentRef,
  ExecuteRequest,
  RollbackRetryStartResult,
  StreamExecuteRequest,
} from "../../../contracts/execution/execution.js";
import {
  toSessionIdentity,
  type MessageInfo,
  type SessionIdentity,
  type SessionOriginChannel,
} from "../../../contracts/session/session.js";
import { isRootUserRevisionAnchor } from "../../../contracts/session/message-visibility.js";
import type { ExecutionSessionPort } from "../../../contracts/session/session-application.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import { asString, renderBackgroundNotification } from "./helpers.js";
import { resolveReadyAgent } from "./readiness.js";
import type { AttachmentResolver } from "./attachment-resolver.js";
import { createCommandRefPart, parseSlashCommand, type SlashCommandHandler } from "./slash-command-handler.js";
import type { AgentRunEngine } from "./run-engine.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { AgentExecutionEventPublisher } from "./event-publisher.js";
import type { MessageExtension } from "../context/extensions/kinds.js";
import type { SessionNotificationQueue } from "../../runtime/session-notification-queue.js";
import type { TenantId } from "../../../identity/types.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import type { Goal, GoalContinuationReason, GoalStore } from "../../../contracts/runtime/goals.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { ExecutionResultReader } from "../../../contracts/execution/execution-storage.js";
import type {
  AgentInvocationChildInput,
} from "../../../contracts/execution/agent-invocation.js";
import type {
  AgentMailboxMessage,
  AgentMailboxStorePort,
  AgentMailboxWakeupTarget,
} from "../../../contracts/storage/agent-mailbox-repository.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { ExecutionStartOptions } from "../../../contracts/execution/execution-application.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type { RunInfo } from "../../../contracts/conversation-store/index.js";
import type {
  AgentInvocationHandle,
  AgentInvocationOutcome,
  AgentInvocationPort,
} from "../../../contracts/execution/agent-invocation.js";
import type { ParticipantRunLifecyclePort } from "../delegation/port.js";
import type { UserMessageTransformInput } from "../../../plugins/backend-plugin.js";
import { terminalReasonDisplay } from "../../../contracts/storage/runtime-finalization.js";

/** 用户消息持久化前变换管道（由容器组装闭包，注入 readAttachment/modelAdapter/systemConfig）。 */
export type UserMessageTransformRunner = (
  input: Omit<UserMessageTransformInput, "readAttachment" | "modelAdapter" | "systemConfig">,
) => Promise<MessageContentPart[] | null>;

/**
 * 用户消息变换管道的最长等待。变换是"尽力而为"的富化（如图片视觉描述），
 * 超过该时限回退原始 contentParts 并 abort 在途调用（视觉 HTTP 请求随之取消）。
 * 该时限必须小于 chat-sdk 客户端的 send ACK 窗口（5s），否则后端先回 ACK 前
 * 客户端已超时报"发送超时，未收到确认"（尽管 run 随后仍会启动）。
 */
const USER_MESSAGE_TRANSFORM_DEADLINE_MS = 4000;

export async function runUserMessageTransformWithDeadline(
  transform: UserMessageTransformRunner,
  input: Parameters<UserMessageTransformRunner>[0],
): Promise<MessageContentPart[] | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, USER_MESSAGE_TRANSFORM_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    const pending = transform({ ...input, signal: controller.signal });
    // deadline 已决后 transformer 的迟到 rejection 不应变成 unhandled rejection。
    pending.catch(() => undefined);
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface UnifiedRunStartInput {
  sessionId: string;
  sessionIdentity: SessionIdentity;
  userId: string;
  requestId: string;
  task: string;
  executionKind: string;
  selectedLlm: string;
  agentName?: string | null;
  modelTask?: string;
  entrypoint?: string;
  persistMetadata: Record<string, unknown>;
  persistContentParts: MessageContentPart[];
  traceMetadata?: Record<string, unknown>;
  sessionMaintenanceToken?: string;
  awaitFollowupCompletion?: boolean;
  followupPolicy: "queue" | "reject";
  onInteractionRequired?: ExecuteRequest["onInteractionRequired"];
}

type UnifiedRunStartResult =
  | { ok: false; error: string }
  | { ok: true; agentName: string; handle: AgentInvocationHandle };

interface SendUserMessageInput {
  sessionId?: string | null;
  userId: string;
  requestId: string;
  task: string;
  attachments: AttachmentRef[];
  selectedLlm: string;
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
  attachments?: AttachmentRef[] | null;
  uiContext?: Record<string, unknown> | null;
}

export interface AgentMailboxContinuationCompletionInput {
  sessionId: string;
  sourceRunId: string;
  sourceAgentCallId: string;
  sourceAgentName: string;
  sourceChildAgentId: string;
  parentRunId: string | null;
  correlationId?: string | null;
  replyToMessageId?: string | null;
  outcome: AgentInvocationOutcome;
}

export interface LauncherApi {
  startStream(request: StreamExecuteRequest, requestId: string, options?: ExecutionStartOptions): Promise<AgentRunStartResult>;
  executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult>;
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
  notificationQueue: SessionNotificationQueue;
  backgroundTasks: BackgroundTaskService | null;
  goalStore: GoalStore | null;
  runtimeStorage: RuntimeStorage;
  clientEvents: ClientEventPublisher;
  mailbox?: AgentMailboxStorePort | null;
  runReader?: Pick<ExecutionResultReader, "getRun"> & Partial<Pick<ExecutionResultReader, "getMessageById" | "listRuns">>;
  participantRuns: ParticipantRunLifecyclePort;
  transformUserMessage?: UserMessageTransformRunner | null;
}

interface MailboxLaunchState {
  target: AgentMailboxWakeupTarget;
  dirty: boolean;
}

type MailboxLaunchDisposition = "completed" | "deferred" | "skipped";

export const MAILBOX_CONTINUATION_REQUEST_PREFIX = "agent_result:";

export function mailboxContinuationSourceMessageId(requestId: string | null | undefined): string | null {
  const normalized = requestId?.trim() ?? "";
  if (!normalized.startsWith(MAILBOX_CONTINUATION_REQUEST_PREFIX)) return null;
  return normalized.slice(MAILBOX_CONTINUATION_REQUEST_PREFIX.length).trim() || null;
}

function mailboxContinuationIds(target: AgentMailboxWakeupTarget): {
  runId: string;
  taskId: string;
  rootCallId: string;
} | null {
  const sourceMessageId = target.sourceMessageId?.trim();
  if (!sourceMessageId) return null;
  const digest = createHash("sha256")
    .update(`${target.sessionId}\0${target.targetRunId}\0${target.targetAgentCallId ?? ""}\0${sourceMessageId}`)
    .digest("hex")
    .slice(0, 32);
  return {
    runId: `mailbox_${digest}`,
    taskId: `mailbox_task_${digest}`,
    rootCallId: `call_mailbox_${digest}`,
  };
}

function renderMailboxContentParts(parts: AgentMailboxMessage["content_parts"]): string {
  return parts.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "command_ref" && part.resolution.kind === "prompt") {
      return [part.resolution.agent_text];
    }
    return [];
  }).join("\n").trim();
}

function mailboxContinuationInitialMessage(
  message: AgentMailboxMessage,
  runId: string,
): NonNullable<AgentInvocationChildInput["initialMessage"]> {
  const displayContent = renderMailboxContentParts(message.content_parts);
  const content = message.input_type === "user_message"
    ? displayContent
    : `[agent-message kind=${message.kind} id=${message.message_id}]\n${displayContent}\n[/agent-message]`;
  return {
    id: message.message_id,
    content,
    contentParts: message.input_type === "user_message"
      ? message.content_parts
      : [{ type: "text", text: content }],
    metadata: {
      ...message.metadata,
      ...(message.input_type === "user_message" ? {} : { agent_message: true }),
      agent_message_display_content: displayContent,
      mailbox_message_id: message.message_id,
      mailbox_kind: message.kind,
      mailbox_correlation_id: message.correlation_id,
      mailbox_reply_to_message_id: message.reply_to_message_id,
      mailbox_source_run_id: message.source_run_id,
      mailbox_source_agent_call_id: message.source_agent_call_id,
      conversation_scope: message.target_child_agent_id ? "child" : "agent",
      consumed_by_run_id: runId,
      run_id: runId,
      visible_to_user: message.visible_to_user,
      sent_at: message.sent_at,
    },
  };
}

function mailboxTargetMatchesRun(target: AgentMailboxWakeupTarget, run: RunInfo): boolean {
  return run.session_id === target.sessionId
    && run.run_id === target.targetRunId
    && run.agent_call_id === target.targetAgentCallId
    && run.thread_key === target.targetThreadKey
    && run.child_agent_id === target.targetChildAgentId
    && run.agent_name === target.targetAgentName
    && run.lease_root_run_id === target.targetRootRunId
    && run.parent_run_id === target.targetParentRunId
    && run.parent_call_id === target.targetParentCallId
    && run.lineage_parent_call_id === target.targetLineageParentCallId;
}

/**
 * 执行启动适配层。startStream / executeSynchronously 只负责各自的输入预处理与返回值适配，
 * readiness、session override 和 AgentRunEngine.startRun 统一经过 launchRun。
 */
class AgentLaunchers {
  private readonly idleLaunches = new Set<string>();
  private readonly mailboxLaunches = new Map<string, MailboxLaunchState>();

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
    private readonly notificationQueue: SessionNotificationQueue,
    private readonly backgroundTasks: BackgroundTaskService | null,
    private readonly goalStore: GoalStore | null,
    private readonly runtimeStorage: RuntimeStorage,
    private readonly clientEvents: ClientEventPublisher,
    private readonly mailbox: AgentMailboxStorePort | null,
    private readonly runReader: (Pick<ExecutionResultReader, "getRun"> & Partial<Pick<ExecutionResultReader, "getMessageById" | "listRuns">>) | null,
    private readonly participantRuns: ParticipantRunLifecyclePort,
    private readonly transformUserMessage: UserMessageTransformRunner | null,
  ) {}

  private async durableActiveRunId(sessionId: string): Promise<string | null> {
    return (await this.runtimeStorage.operations.getActiveRootRun?.(sessionId))?.runId ?? null;
  }

  private launchRun(input: UnifiedRunStartInput): UnifiedRunStartResult {
    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: input.agentName?.trim() || input.sessionIdentity.teamSnapshot.entry_agent_name,
        teamSnapshot: input.sessionIdentity.teamSnapshot,
        selectedLlm: input.selectedLlm,
      },
    );
    if (!ready.ok) {
      return { ok: false, error: ready.reason };
    }

    const handle = this.invocationService.invoke({
      scope: "root",
      mode: "create",
      execution: "foreground",
      sessionId: input.sessionId,
      sessionIdentity: input.sessionIdentity,
      userId: input.userId,
      requestId: input.requestId,
      task: input.task,
      ...(input.modelTask ? { modelTask: input.modelTask } : {}),
      executionKind: input.executionKind,
      ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
      agent: ready.agent,
      provider: ready.provider,
      modelName: ready.modelName,
      ...(input.selectedLlm
        ? { selectedLlm: { provider: ready.provider, modelName: ready.modelName } }
        : {}),
      persistUserMessage: {
        metadata: input.persistMetadata,
        contentParts: input.persistContentParts,
        inputType: "user_message",
        sourceKind: "user",
        visibleToUser: true,
      },
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
      followupPolicy: input.followupPolicy,
    });
    return { ok: true, agentName: ready.agent.agent_name, handle };
  }

  private async waitForRunResult(
    sessionId: string,
    started: Extract<UnifiedRunStartResult, { ok: true }>,
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

    if (slashCommand) {
      const commandResult = await this.slashCommandHandler.handle({
        sessionId,
        sessionIdentity,
        userId: input.userId,
        requestId: input.requestId,
        selectedLlm: input.selectedLlm,
        command: slashCommand,
        originalTask: task,
        ...(input.messageMetadata ? { messageMetadata: input.messageMetadata } : {}),
        ...(input.sessionMaintenanceToken ? { sessionMaintenanceToken: input.sessionMaintenanceToken } : {}),
      });
      if (commandResult) {
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
    // 变换有截止时限：超时回退原始 contentParts，避免阻塞 WS send ACK。
    const persistedContentParts = this.transformUserMessage
      ? (await runUserMessageTransformWithDeadline(this.transformUserMessage, {
          sessionId,
          tenantId: this.tenantId,
          contentParts,
          attachments: attachmentResolution.attachments,
        })) ?? contentParts
      : contentParts;

    const started = this.launchRun({
      sessionId,
      sessionIdentity,
      userId: input.userId,
      requestId: input.requestId,
      task,
      ...(slashCommand?.mode === "prompt" ? { modelTask: slashCommand.agentText } : {}),
      executionKind: input.executionKind,
      selectedLlm: input.selectedLlm,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
      persistMetadata: {
        ...(input.messageMetadata ?? {}),
        ...(extensions.length ? { extensions } : {}),
      },
      persistContentParts: persistedContentParts,
      ...(input.traceMetadata ? { traceMetadata: input.traceMetadata } : {}),
      ...(input.sessionMaintenanceToken ? { sessionMaintenanceToken: input.sessionMaintenanceToken } : {}),
      ...(input.awaitFollowupCompletion ? { awaitFollowupCompletion: true } : {}),
      followupPolicy: input.followupPolicy,
      ...(input.onInteractionRequired ? { onInteractionRequired: input.onInteractionRequired } : {}),
    });
    if (!started.ok) {
      return { kind: "error", sessionId, error: started.error };
    }
    return { kind: "run", sessionId, agentName: started.agentName, handle: started.handle };
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
      selectedLlm: request.selected_llm ?? "",
      ...(request.ui_context !== undefined ? { uiContext: request.ui_context } : {}),
      followupPolicy: options.followupPolicy ?? "queue",
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
      selectedLlm: request.selected_llm ?? "",
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
      ok: true,
      agentName: submitted.agentName,
      handle: submitted.handle,
    });
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
    const task = input.modifyUserMessage?.trim() || retryMessage.content.trim();
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

    const maintenanceToken = randomUUID();
    const maintenanceTtlMs = 60_000;
    const maintenance = await this.runtimeStorage.operations.claimSessionMaintenance({
      sessionId,
      token: maintenanceToken,
      kind: "rollback",
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
        selectedLlm: input.selectedLlm ?? "",
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

  /**
   * BackgroundTaskService 的单一 session-level trigger 消费者。本地 Set 合并同一进程的
   * 重复 idle 事件，GoalStore.claimContinuation 再用持久化 generation/pending 防止多实例
   * 重复续跑。只有 root run、后台任务和待消费通知都空闲时，active Goal 才会续跑。
   */
  triggerBgNotificationRun(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || this.idleLaunches.has(normalizedSessionId)) return;
    this.idleLaunches.add(normalizedSessionId);
    void this.startSessionIdleRun(normalizedSessionId)
      .catch(() => undefined)
      .finally(() => this.idleLaunches.delete(normalizedSessionId));
  }

  /** Wake one exact participant target for queued Agent communication. */
  triggerAgentMailboxRun(target: AgentMailboxWakeupTarget): void {
    const sessionId = target.sessionId.trim();
    const targetRunId = target.targetRunId.trim();
    if (!sessionId || !targetRunId) return;
    const key = `${sessionId}:${targetRunId}:${target.targetAgentCallId ?? ""}`;
    const existing = this.mailboxLaunches.get(key);
    if (existing) {
      existing.target = target;
      existing.dirty = true;
      return;
    }
    const state: MailboxLaunchState = { target, dirty: false };
    this.mailboxLaunches.set(key, state);
    void this.drainAgentMailboxTarget(state)
      .catch(() => undefined)
      .finally(() => {
        if (this.mailboxLaunches.get(key) !== state) return;
        this.mailboxLaunches.delete(key);
        if (state.dirty) this.triggerAgentMailboxRun(state.target);
      });
  }

  private async drainAgentMailboxTarget(state: MailboxLaunchState): Promise<void> {
    for (;;) {
      state.dirty = false;
      const disposition = await this.startAgentMailboxRun(state.target);
      if (disposition === "deferred") {
        if (state.dirty) continue;
        return;
      }
      if (disposition !== "completed") return;
      const next = await this.findStablePendingMailboxTarget(state);
      if (!next) return;
      state.target = next;
    }
  }

  private async findStablePendingMailboxTarget(
    state: MailboxLaunchState,
  ): Promise<AgentMailboxWakeupTarget | null> {
    state.dirty = false;
    const pending = await this.findPendingMailboxTarget(state.target);
    if (pending) return pending;
    return state.dirty ? state.target : null;
  }

  private async findPendingMailboxTarget(
    target: AgentMailboxWakeupTarget,
  ): Promise<AgentMailboxWakeupTarget | null> {
    const pending = await this.mailbox?.listPending?.({
      sessionId: target.sessionId,
      targetRunId: target.targetRunId,
      targetAgentCallId: target.targetAgentCallId,
      targetThreadKey: target.targetThreadKey,
      targetChildAgentId: target.targetChildAgentId,
      limit: 1,
    }) ?? [];
    const first = pending[0];
    return first?.target_run_id ? toMailboxWakeupTarget(first) : null;
  }

  private async startAgentMailboxRun(target: AgentMailboxWakeupTarget): Promise<MailboxLaunchDisposition> {
    const targetsChild = Boolean(target.targetChildAgentId);
    if (!targetsChild) {
      const currentStatus = this.statusTracker.getStatusBySession(target.sessionId)?.status;
      if (currentStatus === "running" || currentStatus === "suspended") return "deferred";
      if (await this.durableActiveRunId(target.sessionId)) return "deferred";
      if (await this.backgroundTasks?.hasRunningTasksDurable(target.sessionId)) return "deferred";
    }
    if (!this.mailbox || !this.runReader) return "skipped";
    const durableTarget = await this.runReader.getRun(target.sessionId, target.targetRunId);
    if (!durableTarget) return "skipped";
    if (!mailboxTargetMatchesRun(target, durableTarget)) return "skipped";
    if (durableTarget.status === "running" || durableTarget.status === "suspended") return "deferred";
    if (!target.sourceMessageId) {
      const pendingTarget = await this.findPendingMailboxTarget(target);
      if (!pendingTarget) return "skipped";
      target = pendingTarget;
    }
    const sourceMessage = target.sourceMessageId
      ? await this.mailbox.get(target.sessionId, target.sourceMessageId)
      : null;
    if (!sourceMessage || sourceMessage.status !== "queued") return "skipped";
    const durableSourceTarget = toMailboxWakeupTarget(sourceMessage);
    if (!mailboxTargetMatchesRun(durableSourceTarget, durableTarget)) return "skipped";
    target = durableSourceTarget;
    const session = await this.sessions.getSession(target.sessionId);
    if (!session) return "skipped";
    const sessionIdentity = toSessionIdentity(session);
    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: durableTarget.agent_name,
        teamSnapshot: sessionIdentity.teamSnapshot,
        selectedLlm: null,
      },
    );
    if (!ready.ok) return "skipped";
    const continuationIds = mailboxContinuationIds(target);
    if (!continuationIds) return "skipped";
    const { runId, taskId, rootCallId } = continuationIds;
    const task = "处理来自 Agent 的消息，并继续当前任务。";
    const base = {
      mode: "create" as const,
      execution: "background" as const,
      sessionId: target.sessionId,
      sessionIdentity,
      runId,
      taskId,
      rootCallId,
      requestId: `${MAILBOX_CONTINUATION_REQUEST_PREFIX}${target.sourceMessageId}`,
      task,
      executionKind: "system.agent_message",
      agent: ready.agent,
      provider: ready.provider,
      modelName: ready.modelName,
      mailboxTargetRunId: target.targetRunId,
      mailboxTargetAgentCallId: target.targetAgentCallId,
    };
    let participantRegistered = false;
    let completedChildTarget: AgentMailboxWakeupTarget | null = null;
    try {
      if (target.targetChildAgentId) {
        await this.participantRuns.registerParticipantRun({
          sessionId: target.sessionId,
          childAgentId: target.targetChildAgentId,
          runId,
          agentCallId: rootCallId,
          rootRunId: runId,
          parentRunId: target.targetParentRunId,
          parentCallId: target.targetParentCallId,
          lineageParentCallId: target.targetLineageParentCallId,
          replacesRunId: target.targetRunId,
        });
        participantRegistered = true;
      }
      const started = target.targetChildAgentId
        ? this.invocationService.invoke({
            ...base,
            scope: "child",
            startedAt: new Date(),
            threadKey: target.targetThreadKey,
            rootRunId: runId,
            interactionRootCallId: target.targetAgentCallId ?? rootCallId,
            parentRunId: target.targetParentRunId,
            parentCallId: target.targetParentCallId,
            lineageParentCallId: target.targetLineageParentCallId,
            childAgentId: target.targetChildAgentId,
            initialMessage: mailboxContinuationInitialMessage(sourceMessage, runId),
            participantExpectedLastRunId: target.targetRunId,
            initialMailboxMessageId: sourceMessage.message_id,
            ownsRunLease: true,
          })
        : this.invocationService.invoke({
            ...base,
            scope: "root",
            rootCallId,
            rootMailboxMessage: {
              id: sourceMessage.message_id,
              inputType: sourceMessage.input_type,
              sourceKind: sourceMessage.source_kind,
              visibleToUser: sourceMessage.visible_to_user,
              sentAt: sourceMessage.sent_at ?? sourceMessage.created_at,
              contentParts: sourceMessage.content_parts,
              metadata: sourceMessage.metadata,
            },
          });
      try {
        await started.durableStarted;
      } catch (error) {
        if (!targetsChild && isActiveRootRunConflict(error)) return "deferred";
        throw error;
      }
      const outcome = await started.promise;
      if (targetsChild && !outcome.suspended) {
        completedChildTarget = {
          ...target,
          targetRunId: runId,
          targetAgentCallId: rootCallId,
          targetRootRunId: runId,
        };
        await this.completeAgentMailboxContinuation({
          sessionId: target.sessionId,
          sourceRunId: runId,
          sourceAgentCallId: rootCallId,
          sourceAgentName: target.targetAgentName ?? ready.agent.agent_name,
          sourceChildAgentId: target.targetChildAgentId!,
          parentRunId: target.targetParentRunId,
          correlationId: target.correlationId ?? null,
          replyToMessageId: target.sourceMessageId ?? null,
          outcome,
        });
      }
      return outcome.suspended ? "skipped" : "completed";
    } finally {
      if (participantRegistered && target.targetChildAgentId) {
        this.participantRuns.releaseParticipantRun({
          childAgentId: target.targetChildAgentId,
          runId,
        });
      }
      try {
        if (completedChildTarget) {
          const pending = await this.findPendingMailboxTarget(completedChildTarget);
          if (pending) this.triggerAgentMailboxRun(pending);
        }
      } finally {
        this.backgroundTasks?.scheduleAutoTrigger(target.sessionId);
      }
    }
  }

  async completeAgentMailboxContinuation(input: AgentMailboxContinuationCompletionInput): Promise<void> {
    if (!this.mailbox || !this.runReader || !input.parentRunId) return;
    const parent = await this.runReader.getRun(input.sessionId, input.parentRunId);
    if (!parent) return;
    const repliedMessage = input.replyToMessageId && !input.correlationId
      ? await this.mailbox.get(input.sessionId, input.replyToMessageId)
      : null;
    const content = input.outcome.content.trim()
      || (input.outcome.success ? "子 Agent 已完成消息处理" : "子 Agent 消息处理失败");
    const queued = await this.mailbox.enqueue({
      messageId: `${input.sourceRunId}:terminal_result`,
      tenantId: this.tenantId,
      sessionId: input.sessionId,
      sourceRunId: input.sourceRunId,
      sourceAgentCallId: input.sourceAgentCallId,
      targetRunId: parent.run_id,
      targetAgentCallId: parent.agent_call_id,
      targetThreadKey: parent.thread_key,
      targetChildAgentId: parent.child_agent_id,
      kind: "result",
      correlationId: input.correlationId
        ?? repliedMessage?.correlation_id
        ?? input.replyToMessageId
        ?? input.sourceAgentCallId,
      replyToMessageId: input.replyToMessageId ?? null,
      contentParts: input.outcome.contentParts?.length
        ? input.outcome.contentParts
        : [{ type: "text", text: content }],
      metadata: {
        source: "agent_message_continuation_result",
        direction: "child_to_parent",
        source_agent_name: input.sourceAgentName,
        source_child_agent_id: input.sourceChildAgentId,
        child_agent_id: input.sourceChildAgentId,
        child_run_id: input.sourceRunId,
        child_agent_call_id: input.sourceAgentCallId,
        target_agent_name: parent.agent_name,
        target_child_agent_id: parent.child_agent_id,
        target_thread_key: parent.thread_key,
        target_root_run_id: parent.lease_root_run_id,
        target_parent_run_id: parent.parent_run_id,
        target_parent_call_id: parent.parent_call_id,
        target_parent_agent_call_id: parent.lineage_parent_call_id,
        target_lineage_parent_call_id: parent.lineage_parent_call_id,
        status: input.outcome.success ? "completed" : "failed",
        success: input.outcome.success,
        visible_to_user: false,
      },
    });
    this.triggerAgentMailboxRun({
      sessionId: input.sessionId,
      targetRunId: parent.run_id,
      targetAgentCallId: parent.agent_call_id,
      targetThreadKey: parent.thread_key,
      targetChildAgentId: parent.child_agent_id,
      targetAgentName: parent.agent_name,
      targetRootRunId: parent.lease_root_run_id,
      targetParentRunId: parent.parent_run_id,
      targetParentCallId: parent.parent_call_id,
      targetLineageParentCallId: parent.lineage_parent_call_id,
      sourceMessageId: queued.message_id,
      correlationId: queued.correlation_id,
    });
  }

  private async recoverMailboxContinuationResults(sessionId: string): Promise<void> {
    if (!this.mailbox || !this.runReader?.listRuns || !this.runReader.getMessageById) return;
    const pageSize = 500;
    for (let offset = 0;; offset += pageSize) {
      const runs = await this.runReader.listRuns(sessionId, pageSize, offset);
      for (const run of runs.items) {
        if (
          run.entrypoint !== "system.agent_message"
          || !run.child_agent_id
          || !run.parent_run_id
          || !["completed", "failed", "interrupted"].includes(run.status)
          || !run.request_id?.startsWith(MAILBOX_CONTINUATION_REQUEST_PREFIX)
        ) {
          continue;
        }
        const sourceMessageId = run.request_id.slice(MAILBOX_CONTINUATION_REQUEST_PREFIX.length).trim();
        if (!sourceMessageId) continue;
        const sourceMessage = await this.mailbox.get(sessionId, sourceMessageId);
        if (!sourceMessage) continue;
        if (sourceMessage.status === "queued" || sourceMessage.status === "claimed") {
          const settled = await this.mailbox.settle({ sessionId, messageId: sourceMessageId });
          if (!settled) continue;
        }
        const existingResult = await this.mailbox.get(sessionId, `${run.run_id}:terminal_result`);
        if (existingResult) {
          if (existingResult.status === "queued" && existingResult.target_run_id) {
            this.triggerAgentMailboxRun(toMailboxWakeupTarget(existingResult));
          }
          continue;
        }
        const finalMessage = run.final_message_id
          ? await this.runReader.getMessageById(sessionId, run.final_message_id)
          : null;
        const failedStatus = run.status === "interrupted" ? "interrupted" : "failed";
        const fallbackContent = run.status === "completed"
          ? "子 Agent 已完成消息处理"
          : terminalReasonDisplay(
              failedStatus,
              run.terminal_reason?.trim() || (failedStatus === "failed" ? "未提供失败原因" : "未提供中断原因"),
            );
        await this.completeAgentMailboxContinuation({
          sessionId,
          sourceRunId: run.run_id,
          sourceAgentCallId: run.agent_call_id,
          sourceAgentName: run.agent_name ?? "agent",
          sourceChildAgentId: run.child_agent_id,
          parentRunId: run.parent_run_id,
          correlationId: sourceMessage.correlation_id,
          replyToMessageId: sourceMessageId,
          outcome: {
            content: finalMessage?.content ?? fallbackContent,
            contentParts: finalMessage?.content_parts ?? [{ type: "text", text: fallbackContent }],
            success: run.status === "completed",
            runId: run.run_id,
          },
        });
      }
      if (runs.items.length < pageSize || offset + runs.items.length >= runs.total) break;
    }
  }

  private async startSessionIdleRun(sessionId: string): Promise<void> {
    let claimedGoal: Goal | null = null;
    let payloads: Parameters<SessionNotificationQueue["add"]>[1][] = [];
    let releaseOwned = true;
    const releaseClaim = async (): Promise<void> => {
      if (!claimedGoal || !this.goalStore) return;
      await this.goalStore.releaseContinuation(
        sessionId,
        claimedGoal.id,
        claimedGoal.continuation_generation,
      );
    };

    try {
      await this.recoverMailboxContinuationResults(sessionId);
      const currentGoal = await this.goalStore?.getCurrent(sessionId) ?? null;
      const markReason = async (reason: GoalContinuationReason): Promise<void> => {
        if (currentGoal && this.goalStore?.setContinuationReason) {
          await this.goalStore.setContinuationReason(sessionId, currentGoal.id, reason);
        }
      };
      const status = this.statusTracker.getStatusBySession(sessionId)?.status;
      if (
        status === "running"
        || status === "suspended"
      ) {
        await markReason("run_still_running");
        return;
      }
      if (await this.backgroundTasks?.hasRunningTasksDurable(sessionId)) {
        await markReason("background_tasks_running");
        return;
      }
      // Any durable Agent message may require a continuation when the in-process
      // wakeup was lost (for example after an instance restart). Terminal results
      // are only one mailbox kind; progress/request/response/cancel must not be
      // stranded behind a result-only scan.
      const pendingMailbox = await this.mailbox?.listPending?.({ sessionId, limit: 1 }) ?? [];
      const firstMailbox = pendingMailbox[0];
      if (firstMailbox?.input_type === "user_message" && firstMailbox.target_thread_key === "root") {
        const existingSession = await this.sessions.getSession(sessionId);
        if (!existingSession) return;
        const sessionIdentity = toSessionIdentity(existingSession);
        const ready = resolveReadyAgent(this.runtimeCore, {
          agentName: sessionIdentity.teamSnapshot.entry_agent_name,
          teamSnapshot: sessionIdentity.teamSnapshot,
          selectedLlm: null,
        });
        if (!ready.ok) return;
        const started = this.invocationService.invoke({
          scope: "root",
          mode: "create",
          execution: "background",
          sessionId,
          sessionIdentity,
          requestId: `session_followup_${firstMailbox.message_id}`,
          task: "处理待接收的用户消息，并继续当前任务。",
          executionKind: "session_followup",
          agent: ready.agent,
          provider: ready.provider,
          modelName: ready.modelName,
          rootMailboxMessage: {
            id: firstMailbox.message_id,
            inputType: firstMailbox.input_type,
            sourceKind: "user",
            visibleToUser: firstMailbox.visible_to_user,
            sentAt: firstMailbox.sent_at ?? firstMailbox.created_at,
            contentParts: firstMailbox.content_parts,
            metadata: firstMailbox.metadata,
          },
        });
        void started.promise.finally(() => this.backgroundTasks?.scheduleAutoTrigger(sessionId)).catch(() => undefined);
        await started.durableStarted;
        return;
      }
      if (firstMailbox?.target_run_id) {
        this.triggerAgentMailboxRun(toMailboxWakeupTarget(firstMailbox));
        return;
      }
      const hasNotifications = this.notificationQueue.peek(sessionId);
      if (!hasNotifications && currentGoal?.status !== "active") {
        if (currentGoal) await markReason(currentGoal.status === "paused" ? "manual_paused" : "goal_not_active");
        return;
      }

      const existingSession = await this.sessions.getSession(sessionId);
      if (!existingSession) return;
      const sessionIdentity = toSessionIdentity(existingSession);
      const ready = resolveReadyAgent(
        this.runtimeCore,
        {
          agentName: sessionIdentity.teamSnapshot.entry_agent_name,
          teamSnapshot: sessionIdentity.teamSnapshot,
          selectedLlm: null,
        },
      );
      if (!ready.ok) {
        await markReason("readiness_failed");
        return;
      }

      // Session/agent readiness may require SaaS I/O. Claim only after those checks pass so a
      // configuration failure or an intervening user run does not consume a continuation attempt.
      const readyStatus = this.statusTracker.getStatusBySession(sessionId)?.status;
      if (
        readyStatus === "running"
        || readyStatus === "suspended"
      ) {
        await markReason("run_still_running");
        return;
      }
      if (await this.backgroundTasks?.hasRunningTasksDurable(sessionId)) {
        await markReason("background_tasks_running");
        return;
      }
      if (currentGoal?.status === "active" && this.goalStore) {
        if (currentGoal.continuation_pending && currentGoal.continuation_claimed_at) {
          await markReason("continuation_pending");
        }
        claimedGoal = await this.goalStore.claimContinuation(sessionId, {
          maxContinuations: 20,
          maxNoProgress: 3,
          leaseTimeoutMs: 120_000,
        });
      }

      // Re-read durable background work after the asynchronous continuation claim. If another
      // instance started work meanwhile, finally releases this claim for a later idle attempt.
      if (await this.backgroundTasks?.hasRunningTasksDurable(sessionId)) {
        await markReason("background_tasks_running");
        return;
      }
      // The durable gate above yields. Re-read local status after it resolves, then keep the
      // remaining path synchronous through startRun so a same-process user run cannot interleave.
      const latestStatus = this.statusTracker.getStatusBySession(sessionId)?.status;
      if (latestStatus === "running" || latestStatus === "suspended") {
        await markReason("run_still_running");
        return;
      }
      if (!hasNotifications && !claimedGoal) {
        const latestGoal = await this.goalStore?.getCurrent(sessionId) ?? null;
        if (latestGoal?.status === "active" && latestGoal.continuation_pending && this.goalStore?.setContinuationReason) {
          await this.goalStore.setContinuationReason(sessionId, latestGoal.id, "continuation_pending");
        }
        return;
      }

      payloads = this.notificationQueue.drain(sessionId);
      if (!payloads.length && !claimedGoal) {
        return;
      }
      const task = [
        ...payloads.map(renderBackgroundNotification),
        ...(claimedGoal ? [renderGoalContinuation(claimedGoal)] : []),
      ].filter(Boolean).join("\n\n");
      const source = claimedGoal ? "goal_continuation" : "background_notification";
      const started = this.invocationService.invoke({
        scope: "root",
        mode: "create",
        execution: "background",
        sessionId,
        sessionIdentity,
        requestId: `${claimedGoal ? "goal_continue" : "bg_notify"}_${randomUUID()}`,
        task,
        executionKind: claimedGoal ? "system.goal_continuation" : "system.bg_notification",
        agent: ready.agent,
        provider: ready.provider,
        modelName: ready.modelName,
        persistUserMessage: {
          contentParts: [{ type: "text", text: task }],
          inputType: claimedGoal ? "goal_continuation" : "system_notification",
          sourceKind: "system",
          visibleToUser: false,
          metadata: {
            source,
            ...(claimedGoal ? {
              goal_id: claimedGoal.id,
              goal_generation: claimedGoal.continuation_generation,
            } : {}),
          },
        },
      });
      releaseOwned = false;
      void started.promise.finally(async () => {
        await releaseClaim();
        this.backgroundTasks?.scheduleAutoTrigger(sessionId);
      }).catch(() => undefined);
      await started.durableStarted;
    } catch (error) {
      for (const payload of payloads) this.notificationQueue.add(sessionId, payload);
      if (claimedGoal && this.goalStore?.setContinuationReason) {
        await this.goalStore.setContinuationReason(sessionId, claimedGoal.id, "continuation_start_failed");
      }
      throw error;
    } finally {
      if (releaseOwned) await releaseClaim();
    }
  }

}

function isActiveRootRunConflict(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith("session already has an active root run: ");
}

function toMailboxWakeupTarget(message: AgentMailboxMessage): AgentMailboxWakeupTarget {
  const metadata = message.metadata;
  const read = (key: string): string | null => asString(metadata[key]);
  return {
    sessionId: message.session_id,
    targetRunId: message.target_run_id ?? "",
    targetAgentCallId: message.target_agent_call_id,
    targetThreadKey: message.target_thread_key,
    targetChildAgentId: message.target_child_agent_id,
    targetAgentName: read("target_agent_name"),
    targetRootRunId: read("target_root_run_id"),
    targetParentRunId: read("target_parent_run_id"),
    targetParentCallId: read("target_parent_call_id"),
    targetLineageParentCallId: read("target_lineage_parent_call_id"),
    sourceMessageId: message.message_id,
    correlationId: message.correlation_id,
  };
}

export function renderGoalContinuation(goal: Goal): string {
  const criteria = goal.success_criteria.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const steps = goal.steps.map((step) => (
    `- [${step.status}] ${step.id}: ${step.title}${step.description ? ` — ${step.description}` : ""}`
  )).join("\n");
  return `<goal-continuation goal-id="${goal.id}" generation="${goal.continuation_generation}">
当前 Session 的 Goal 尚未完成，请继续推进，不要只复述计划。

最终目标：${goal.objective}

验收标准：
${criteria || "- 尚未设置，请先用 goal_update 补充可验证标准"}

当前阶段：
${steps || "- 尚未设置，请根据上下文创建阶段"}

checkpoint: ${JSON.stringify(goal.checkpoint)}
progress: ${JSON.stringify(goal.progress)}

执行规则：
1. 先检查最新会话、产物、后台结果和阶段状态，然后立即执行下一个可推进的动作。
2. 使用 goal_update 动态更新 steps、checkpoint 和 progress，记录实际证据。
3. 只有所有验收标准都有证据时才设为 completed。确实无法继续时设为 blocked；需要用户时请求输入，不要空转。
4. 本轮结束前必须更新 Goal，否则系统会将重复无进展计入循环保护。
</goal-continuation>`;
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
    deps.notificationQueue,
    deps.backgroundTasks,
    deps.goalStore,
    deps.runtimeStorage,
    deps.clientEvents,
    deps.mailbox ?? null,
    deps.runReader ?? null,
    deps.participantRuns,
    deps.transformUserMessage ?? null,
  );
  return {
    startStream: impl.startStream.bind(impl),
    executeSynchronously: impl.executeSynchronously.bind(impl),
    startRollbackRetry: impl.startRollbackRetry.bind(impl),
    triggerBgNotificationRun: impl.triggerBgNotificationRun.bind(impl),
    triggerAgentMailboxRun: impl.triggerAgentMailboxRun.bind(impl),
    completeAgentMailboxContinuation: impl.completeAgentMailboxContinuation.bind(impl),
  };
}
