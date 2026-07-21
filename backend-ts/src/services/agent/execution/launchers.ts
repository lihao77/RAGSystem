import { randomUUID } from "node:crypto";

import type {
  AgentExecuteResult,
  AgentRunStartResult,
  AttachmentRef,
  ExecuteRequest,
  RollbackRetryStartResult,
  StreamExecuteRequest,
} from "../../../contracts/execution/execution.js";
import { getSelectedLlm as resolveSelectedLlm } from "../../../contracts/execution/execution.js";
import type { ExecutionSessionPort } from "../../../contracts/session/session-application.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import {
  asString,
  normalizeSessionEntryAgent,
  renderBackgroundNotification,
} from "./helpers.js";
import { resolveReadyAgent } from "./readiness.js";
import type { AttachmentResolver } from "./attachment-resolver.js";
import { parseSlashCommand, type SlashCommandHandler } from "./slash-command-handler.js";
import type { AgentRunEngine } from "./run-engine.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { AgentExecutionEventPublisher } from "./event-publisher.js";
import type { MessageExtension } from "../context/extensions/kinds.js";
import type { SessionNotificationQueue } from "../../runtime/session-notification-queue.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";
import type { TenantId } from "../../../identity/types.js";

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
  startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult>;
  executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult>;
  /** 后台任务完成通知拉起的 system run（通道 A 消费者，由 BackgroundTaskService.scheduleAutoTrigger 触发）。 */
  triggerBgNotificationRun(sessionId: string): void;
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
  notificationQueue: SessionNotificationQueue;
}

/**
 * 3 个启动入口（startStream/executeSynchronously/startRollbackRetry）。
 * 方法体原样来自原 AgentExecutionService（this.xxx 字段访问保持不变）。
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
    private readonly notificationQueue: SessionNotificationQueue,
  ) {}

  async startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult> {
    const sessionId = request.session_id?.trim() || randomUUID();
    const task = request.task.trim();
    const slashCommand = parseSlashCommand(task);
    // prompt 模式斜杠命令(/review 等):user 消息持久化原始命令(前端显示),展开后的完整 prompt 进 metadata.expanded_task,
    // 由 recent-messages-source 组装 LLM conversation 时投影替换 content(见 history-view messagesToConversation)。
    if (slashCommand) {
      const commandResult = await this.slashCommandHandler.handle({
        sessionId,
        userId: request.userId,
        requestId,
        selectedLlm: resolveSelectedLlm(request),
        command: slashCommand,
        originalTask: task,
      });
      if (commandResult) {
        return commandResult;
      }
    }
    if (!task && request.attachments.length === 0) {
      return {
        started: false,
        session_id: sessionId,
        error: "Task and attachments cannot both be empty",
      };
    }
    const sessionMetadata = (await this.sessions.getSession(sessionId))?.metadata ?? {};
    const attachmentResolution = await this.attachmentResolver.resolveAsync(sessionId, request.attachments);
    if (attachmentResolution.error) {
      return {
        started: false,
        session_id: sessionId,
        error: attachmentResolution.error,
      };
    }

    const requestSelectedLlm = resolveSelectedLlm(request);
    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: normalizeSessionEntryAgent(sessionMetadata.entry_agent),
        teamName: asString(sessionMetadata.team),
        selectedLlm: requestSelectedLlm,
      },
      sessionMetadata,
    );
    if (!ready.ok) {
      return {
        started: false,
        session_id: sessionId,
        error: ready.reason,
      };
    }

    const runtimeAgent = ready.agent;

    // 写入侧拆分:image 进 metadata.extensions(image_attachment),file 留 metadata.attachments。
    // 内容扩展(image/ui_context)统一落 extensions[];消息类型/追溯字段(msg_type/command)留 metadata 顶层。
    const imageAttachments = attachmentResolution.attachments.filter((a) => a.kind === "image");
    const fileAttachments = attachmentResolution.attachments.filter((a) => a.kind !== "image");
    const extensions: MessageExtension[] = [];
    if (request.ui_context) extensions.push({ kind: "ui_context", data: request.ui_context });
    if (imageAttachments.length) extensions.push({ kind: "image_attachment", data: { attachments: imageAttachments } });

    const started = this.runEngine.startRun({
      sessionId,
      userId: request.userId,
      requestId,
      task,
      ...(slashCommand?.mode === "prompt" ? { modelTask: slashCommand.expandedTask } : {}),
      executionKind: "agent_stream",
      agent: runtimeAgent,
      provider: ready.provider,
      modelName: ready.modelName,
      ...(requestSelectedLlm ? { selectedLlm: { provider: ready.provider, modelName: ready.modelName } } : {}),
      persistUserMessage: {
        metadata: {
          ...(slashCommand
            ? {
                msg_type: MSG_TYPE.COMMAND,
                command: slashCommand.name,
                command_mode: slashCommand.mode,
                ...(slashCommand.mode === "prompt" ? { expanded_task: slashCommand.expandedTask } : {}),
              }
            : {}),
          ...(fileAttachments.length ? { attachments: fileAttachments } : {}),
          ...(extensions.length ? { extensions } : {}),
        },
      },
    });
    const { promise: _promise, durableStarted, ...publicStarted } = started;
    try {
      const disposition = await durableStarted;
      if (disposition.kind === "followup") {
        return { started: true, session_id: sessionId, run_id: disposition.activeRunId, request_id: requestId, kind: "agent_run" };
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
    const sessionId = request.session_id?.trim() || randomUUID();
    const task = request.task.trim();
    if (!task) {
      return {
        success: false,
        answer: null,
        agent_name: null,
        execution_time: null,
        tool_calls: [],
        metadata: {},
        session_id: sessionId,
        run_id: null,
        task_id: null,
        error: "Task cannot be empty",
      };
    }
    const runningStatus = this.statusTracker.getStatusBySession(sessionId);
    if (runningStatus?.status === "running") {
      return {
        success: false,
        answer: null,
        agent_name: null,
        execution_time: null,
        tool_calls: [],
        metadata: {},
        session_id: sessionId,
        run_id: runningStatus.run_id,
        task_id: runningStatus.task_id,
        error: "该会话正在执行任务，请等待完成或停止当前任务",
      };
    }
    const session = await this.sessions.getSession(sessionId);
    const sessionMetadata = session?.metadata ?? {};
    const requestSelectedLlm = resolveSelectedLlm(request);
    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: request.agent?.trim() || normalizeSessionEntryAgent(sessionMetadata.entry_agent),
        teamName: asString(sessionMetadata.team),
        selectedLlm: requestSelectedLlm,
      },
      sessionMetadata,
    );
    if (!ready.ok) {
      return {
        success: false,
        answer: null,
        agent_name: null,
        execution_time: null,
        tool_calls: [],
        metadata: {},
        session_id: sessionId,
        run_id: null,
        task_id: null,
        error: ready.reason,
      };
    }

    const runtimeAgent = ready.agent;
    const executionKind = request.executionKind?.trim() || "execute";
    const started = this.runEngine.startRun({
      sessionId,
      userId: request.userId,
      requestId,
      task,
      executionKind,
      ...(request.onInteractionRequired ? { onInteractionRequired: request.onInteractionRequired } : {}),
      entrypoint: "execute",
      agent: runtimeAgent,
      provider: ready.provider,
      modelName: ready.modelName,
      ...(requestSelectedLlm ? { selectedLlm: { provider: ready.provider, modelName: ready.modelName } } : {}),
      persistUserMessage: {
        metadata: {
          agent: runtimeAgent.agent_name,
          request_id: requestId,
          execution_kind: executionKind,
        },
      },
    });
    const outcome = await started.promise;
    return await this.runEngine.buildSynchronousResult({
      sessionId,
      runId: started.run_id ?? null,
      taskId: started.task_id ?? null,
      agentName: runtimeAgent.agent_name,
      outcome,
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
    if (runningStatus?.status === "running") {
      return {
        started: false,
        session_id: sessionId,
        deleted: 0,
        error: "该会话正在执行任务，请等待完成或停止当前任务",
      };
    }

    // 先解析 ready 与确保会话存在——这两步不依赖消息内容，失败时直接返回不触碰消息 DB，
    // 避免 prepareRetry 已改写内容/删除回复、却因 ready 失败留下“内容改了、回复没了、新 run 没起”的中间态。
    const existingSession = await this.sessions.getSession(sessionId);
    const sessionMetadata = existingSession?.metadata ?? {};
    const resolveInput: {
      agentName?: string | null;
      teamName?: string | null;
      selectedLlm?: string | null;
    } = {
      agentName: normalizeSessionEntryAgent(sessionMetadata.entry_agent),
      teamName: asString(sessionMetadata.team),
    };
    if (input.selectedLlm !== undefined) {
      resolveInput.selectedLlm = input.selectedLlm;
    }
    const ready = resolveReadyAgent(this.runtimeCore, resolveInput, sessionMetadata);
    if (!ready.ok) {
      return {
        started: false,
        session_id: sessionId,
        deleted: 0,
        error: ready.reason,
      };
    }
    if (!existingSession) {
      await this.sessions.createSession({ tenantId: this.tenantId, sessionId, userId: input.userId });
    }

    const prepareInput: {
      sessionId: string;
      afterSeq?: number | null;
      afterMessageId?: string | null;
      modifyUserMessage?: string | null;
      metadataPatch?: { attachments?: unknown[]; extensions?: MessageExtension[] };
    } = { sessionId };
    if (input.afterSeq !== undefined) {
      prepareInput.afterSeq = input.afterSeq;
    }
    if (input.afterMessageId !== undefined) {
      prepareInput.afterMessageId = input.afterMessageId;
    }
    if (input.modifyUserMessage !== undefined) {
      prepareInput.modifyUserMessage = input.modifyUserMessage;
    }
    // 编辑重发可能带新附件：解析后按 image/file 拆分（复用 startStream 的拆分逻辑），
    // 打包成 metadataPatch 交给 prepareRetry 合并进用户消息 metadata。
    if (input.attachments && input.attachments.length) {
      const attachmentResolution = await this.attachmentResolver.resolveAsync(sessionId, input.attachments);
      if (attachmentResolution.error) {
        return {
          started: false,
          session_id: sessionId,
          deleted: 0,
          error: attachmentResolution.error,
        };
      }
      const imageAttachments = attachmentResolution.attachments.filter((a) => a.kind === "image");
      const fileAttachments = attachmentResolution.attachments.filter((a) => a.kind !== "image");
      const extensions: MessageExtension[] = [];
      if (input.uiContext) extensions.push({ kind: "ui_context", data: input.uiContext });
      if (imageAttachments.length) extensions.push({ kind: "image_attachment", data: { attachments: imageAttachments } });
      prepareInput.metadataPatch = {
        ...(fileAttachments.length ? { attachments: fileAttachments } : {}),
        ...(extensions.length ? { extensions } : {}),
      };
    } else if (input.uiContext) {
      prepareInput.metadataPatch = { extensions: [{ kind: "ui_context", data: input.uiContext }] };
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
    let deleted = 0;

    const runtimeAgent = ready.agent;
    const started = this.runEngine.startRun({
      sessionId,
      userId: input.userId,
      requestId: input.requestId,
      task,
      executionKind: "rollback_and_retry",
      entrypoint: "rollback_and_retry",
      agent: runtimeAgent,
      provider: ready.provider,
      modelName: ready.modelName,
      ...(input.selectedLlm ? { selectedLlm: { provider: ready.provider, modelName: ready.modelName } } : {}),
      existingUserMessageId: retryMessage.id,
      userMessageSavedPayload: {
        id: retryMessage.id,
        seq: retryMessage.seq,
        role: retryMessage.role,
        retry_of_seq: retryMessage.seq,
        retry_of_message_id: retryMessage.id,
      },
      startStepExtra: {
        retry_of_seq: retryMessage.seq,
        retry_of_message_id: retryMessage.id,
      },
      runStartExtra: {
        retry_of_seq: retryMessage.seq,
        retry_of_message_id: retryMessage.id,
      },
      finalMetadataExtra: {
        retry_of_seq: retryMessage.seq,
        retry_of_message_id: retryMessage.id,
      },
      prepareRun: async () => {
        const prepared = await this.sessions.prepareRetry(prepareInput);
        if (prepared.message.id !== retryMessage.id) throw new Error("重试锚点已被并发修改");
        deleted = prepared.deleted;
      },
    });
    const { promise: _promise, durableStarted, ...publicStarted } = started;
    try {
      await durableStarted;
    } catch (error) {
      return {
        ...publicStarted,
        started: false,
        deleted,
        agent_name: runtimeAgent.agent_name,
        error: error instanceof Error ? error.message : "Run failed before durable start",
      };
    }

    return {
      ...publicStarted,
      deleted,
      agent_name: runtimeAgent.agent_name,
    };
  }

  /**
   * 通道 A 消费者：后台任务完成通知拉起的 system run。由 BackgroundTaskService.scheduleAutoTrigger
   * （后台完成 + run 结束两处）延迟 1s 触发。idle 才执行（不抢用户的 run），drain 队列渲染成
   * <task-notification>XML 作为 task，经 persistUserMessage 落库为 user 消息（source:background_notification），
   * 与前端发送同构——SDK 读历史看到、message_saved 推前端、UserMessage.vue 渲染。
   *
   * 不变量：本方法的「idle 判定 → runEngine.startRun(register)」整段必须同步、不可插入 await——
   * Node 单线程据此保证不与 startStream 的 idle 检查交错（否则会双 register、statusTracker 状态错乱）。
   * 若将来要把 ready 解析/drain 改成异步，须先改用 statusTracker 的原子 registerIfIdle。
   */
  triggerBgNotificationRun(sessionId: string): void {
    if (!sessionId) {
      return;
    }
    if (this.statusTracker.getStatusBySession(sessionId)?.status === "running") {
      return;
    }
    if (!this.notificationQueue.peek(sessionId)) {
      return;
    }
    const payloads = this.notificationQueue.drain(sessionId);
    if (!payloads.length) {
      return;
    }
    void this.startBgNotificationRun(sessionId, payloads).catch(() => {
      for (const payload of payloads) this.notificationQueue.add(sessionId, payload);
    });
  }

  private async startBgNotificationRun(
    sessionId: string,
    payloads: Parameters<SessionNotificationQueue["add"]>[1][],
  ): Promise<void> {
    const task = payloads.map(renderBackgroundNotification).join("\n\n");
    const existingSession = await this.sessions.getSession(sessionId);
    const sessionMetadata = existingSession?.metadata ?? {};
    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: normalizeSessionEntryAgent(sessionMetadata.entry_agent),
        teamName: asString(sessionMetadata.team),
        selectedLlm: null,
      },
      sessionMetadata,
    );
    if (!ready.ok) {
      // ready 失败：回填队列，下次触发或下次 run drain 再消费（对齐 Python notification_trigger.py:79-85）
      for (const payload of payloads) {
        this.notificationQueue.add(sessionId, payload);
      }
      return;
    }
    // Session I/O may be asynchronous in SaaS. Re-check immediately before
    // synchronous startRun registration so an intervening user run wins.
    if (this.statusTracker.getStatusBySession(sessionId)?.status === "running") {
      for (const payload of payloads) this.notificationQueue.add(sessionId, payload);
      return;
    }
    if (!existingSession) {
      await this.sessions.createSystemSession({ tenantId: this.tenantId, sessionId });
      if (this.statusTracker.getStatusBySession(sessionId)?.status === "running") {
        for (const payload of payloads) this.notificationQueue.add(sessionId, payload);
        return;
      }
    }
    const started = this.runEngine.startRun({
      sessionId,
      requestId: `bg_notify_${randomUUID()}`,
      task,
      executionKind: "system.bg_notification",
      agent: ready.agent,
      provider: ready.provider,
      modelName: ready.modelName,
      persistUserMessage: {
        metadata: { source: "background_notification" },
      },
    });
    await started.durableStarted;
  }

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
    deps.notificationQueue,
  );
  return {
    startStream: impl.startStream.bind(impl),
    executeSynchronously: impl.executeSynchronously.bind(impl),
    startRollbackRetry: impl.startRollbackRetry.bind(impl),
    triggerBgNotificationRun: impl.triggerBgNotificationRun.bind(impl),
  };
}
