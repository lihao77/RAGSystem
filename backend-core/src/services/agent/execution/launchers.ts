import { randomUUID } from "node:crypto";

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
  AgentMailboxMessage,
  AgentMailboxStorePort,
  AgentMailboxWakeupTarget,
} from "../../../contracts/storage/agent-mailbox-repository.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { ExecutionStartOptions } from "../../../contracts/execution/execution-application.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type {
  AgentInvocationHandle,
  AgentInvocationPort,
} from "../../../contracts/execution/agent-invocation.js";

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

export interface LauncherApi {
  startStream(request: StreamExecuteRequest, requestId: string, options?: ExecutionStartOptions): Promise<AgentRunStartResult>;
  executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult>;
  /** Session idle 检查：消费后台通知，并在 Goal active 时拉起 continuation run。 */
  triggerBgNotificationRun(sessionId: string): void;
  triggerAgentMailboxRun(target: AgentMailboxWakeupTarget): void;
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
  runReader?: Pick<ExecutionResultReader, "getRun">;
}

/**
 * 执行启动适配层。startStream / executeSynchronously 只负责各自的输入预处理与返回值适配，
 * readiness、session override 和 AgentRunEngine.startRun 统一经过 launchRun。
 */
class AgentLaunchers {
  private readonly idleLaunches = new Set<string>();
  private readonly mailboxLaunches = new Set<string>();

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
    private readonly runReader: Pick<ExecutionResultReader, "getRun"> | null,
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
      persistContentParts: contentParts,
      ...(input.traceMetadata ? { traceMetadata: input.traceMetadata } : {}),
      ...(input.sessionMaintenanceToken ? { sessionMaintenanceToken: input.sessionMaintenanceToken } : {}),
      ...(input.awaitFollowupCompletion ? { awaitFollowupCompletion: true } : {}),
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
    if (retryMessage.role !== "user") {
      return { started: false, session_id: sessionId, deleted: 0, error: "指定位置必须是用户消息（user），才能从此处重试" };
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

  /** Wake one exact parent target for a queued terminal child result. */
  triggerAgentMailboxRun(target: AgentMailboxWakeupTarget): void {
    const sessionId = target.sessionId.trim();
    const targetRunId = target.targetRunId.trim();
    if (!sessionId || !targetRunId) return;
    const key = `${sessionId}:${targetRunId}:${target.targetAgentCallId ?? ""}`;
    if (this.mailboxLaunches.has(key)) return;
    this.mailboxLaunches.add(key);
    void this.startAgentMailboxRun(target)
      .catch(() => undefined)
      .finally(() => this.mailboxLaunches.delete(key));
  }

  private async startAgentMailboxRun(target: AgentMailboxWakeupTarget): Promise<void> {
    const currentStatus = this.statusTracker.getStatusBySession(target.sessionId)?.status;
    if (currentStatus === "running" || currentStatus === "suspended") return;
    if (await this.durableActiveRunId(target.sessionId)) return;
    if (await this.backgroundTasks?.hasRunningTasksDurable(target.sessionId)) return;
    if (!this.runReader) return;
    const durableTarget = await this.runReader.getRun(target.sessionId, target.targetRunId);
    if (!durableTarget) return;
    if (durableTarget?.status === "running" || durableTarget?.status === "suspended") return;
    const session = await this.sessions.getSession(target.sessionId);
    if (!session) return;
    const sessionIdentity = toSessionIdentity(session);
    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: target.targetAgentName,
        teamSnapshot: sessionIdentity.teamSnapshot,
        selectedLlm: null,
      },
    );
    if (!ready.ok) return;
    const runId = randomUUID();
    const taskId = randomUUID();
    const rootCallId = `call_${randomUUID()}`;
    const task = "处理来自 Agent 的消息，并继续当前任务。";
    const base = {
      mode: "create" as const,
      execution: "background" as const,
      sessionId: target.sessionId,
      sessionIdentity,
      runId,
      taskId,
      rootCallId,
      requestId: `agent_result_${target.targetRunId}`,
      task,
      executionKind: "system.agent_message",
      agent: ready.agent,
      provider: ready.provider,
      modelName: ready.modelName,
      mailboxTargetRunId: target.targetRunId,
      mailboxTargetAgentCallId: target.targetAgentCallId,
    };
    const started = target.targetChildAgentId
      ? this.invocationService.invoke({
          ...base,
          scope: "child",
          startedAt: new Date(),
          threadKey: target.targetThreadKey,
          rootRunId: target.targetRootRunId ?? target.targetRunId,
          interactionRootCallId: target.targetAgentCallId ?? rootCallId,
          parentRunId: target.targetParentRunId,
          parentCallId: target.targetParentCallId,
          lineageParentCallId: target.targetLineageParentCallId,
          childAgentId: target.targetChildAgentId,
          ownsRunLease: true,
        })
      : this.invocationService.invoke({
          ...base,
          scope: "root",
          rootCallId,
        });
    try {
      await started.durableStarted;
      await started.promise;
    } finally {
      this.backgroundTasks?.scheduleAutoTrigger(target.sessionId);
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
  );
  return {
    startStream: impl.startStream.bind(impl),
    executeSynchronously: impl.executeSynchronously.bind(impl),
    startRollbackRetry: impl.startRollbackRetry.bind(impl),
    triggerBgNotificationRun: impl.triggerBgNotificationRun.bind(impl),
    triggerAgentMailboxRun: impl.triggerAgentMailboxRun.bind(impl),
  };
}
