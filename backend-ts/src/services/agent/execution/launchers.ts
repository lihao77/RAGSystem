import { randomUUID } from "node:crypto";

import type {
  AgentExecuteResult,
  AgentRunStartResult,
  AttachmentRef,
  ExecuteRequest,
  RollbackRetryStartResult,
  StreamExecuteRequest,
} from "../../../contracts/execution.js";
import { getSelectedLlm as resolveSelectedLlm } from "../../../contracts/execution.js";
import type { AgentSessionApplication } from "../../sessions/index.js";
import type { IRunStore } from "../../../contracts/conversation-store/index.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import {
  asString,
  normalizeSessionEntryAgent,
} from "./helpers.js";
import { resolveReadyAgent } from "./readiness.js";
import type { AttachmentResolver } from "./attachment-resolver.js";
import { parseSlashCommand, type SlashCommandHandler } from "./slash-command-handler.js";
import type { AgentRunEngine } from "./run-engine.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { AgentExecutionEventPublisher } from "./event-publisher.js";
import type { MessageExtension } from "../context/extensions/kinds.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";

export interface RollbackRetryInput {
  sessionId: string;
  userId?: string | null;
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
}

export interface LauncherDeps {
  sessions: AgentSessionApplication;
  conversationStore: IRunStore;
  runtimeCore: RuntimeExecutionConfigResolver;
  slashCommandHandler: SlashCommandHandler;
  attachmentResolver: AttachmentResolver;
  statusTracker: AgentExecutionStatusTracker;
  eventPublisher: AgentExecutionEventPublisher;
  runEngine: AgentRunEngine;
}

/**
 * 3 个启动入口（startStream/executeSynchronously/startRollbackRetry）。
 * 方法体原样来自原 AgentExecutionService（this.xxx 字段访问保持不变）。
 */
class AgentLaunchers {
  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly conversationStore: IRunStore,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly slashCommandHandler: SlashCommandHandler,
    private readonly attachmentResolver: AttachmentResolver,
    private readonly statusTracker: AgentExecutionStatusTracker,
    private readonly eventPublisher: AgentExecutionEventPublisher,
    private readonly runEngine: AgentRunEngine,
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
        userId: request.user_id ?? null,
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
    const sessionMetadata = this.sessions.getSession(sessionId)?.metadata ?? {};
    const runningStatus = this.statusTracker.getStatusBySession(sessionId);
    if (runningStatus?.status === "running") {
      const runningRunId = runningStatus.run_id ?? null;
      const runningTaskId = runningStatus.task_id ?? null;
      const currentAgentName = normalizeSessionEntryAgent(sessionMetadata.entry_agent) ?? "orchestrator_agent";
      const followupMessage = this.sessions.addMessage({
        sessionId,
        role: "user",
        content: task,
        metadata: {
          agent: currentAgentName,
          ...(runningRunId ? { run_id: runningRunId } : {}),
          request_id: requestId,
          execution_kind: "session_followup",
          source: "running_session",
        },
      });
      this.eventPublisher.publishOutputMessageSaved(sessionId, runningRunId, {
        message_id: followupMessage.id,
        seq: followupMessage.seq,
        role: followupMessage.role,
        request_id: requestId,
      });
      return {
        started: true,
        session_id: sessionId,
        ...(runningRunId ? { run_id: runningRunId } : {}),
        ...(runningTaskId ? { task_id: runningTaskId } : {}),
        request_id: requestId,
        kind: "agent_run",
      };
    }

    const attachmentResolution = this.attachmentResolver.resolve(sessionId, request.attachments);
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

    if (!this.sessions.getSession(sessionId)) {
      this.sessions.createSession({ sessionId, userId: request.user_id ?? null });
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
      userId: request.user_id ?? null,
      requestId,
      task,
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
    const { promise: _promise, ...publicStarted } = started;
    return publicStarted;
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
    if (!this.sessions.getSession(sessionId)) {
      this.sessions.createSession({ sessionId, userId: request.user_id ?? null });
    }

    const sessionMetadata = this.sessions.getSession(sessionId)?.metadata ?? {};
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
    const started = this.runEngine.startRun({
      sessionId,
      userId: request.user_id ?? null,
      requestId,
      task,
      executionKind: "execute",
      entrypoint: "execute",
      agent: runtimeAgent,
      provider: ready.provider,
      modelName: ready.modelName,
      ...(requestSelectedLlm ? { selectedLlm: { provider: ready.provider, modelName: ready.modelName } } : {}),
      persistUserMessage: {
        metadata: {
          agent: runtimeAgent.agent_name,
          request_id: requestId,
          execution_kind: "execute",
        },
      },
    });
    await started.promise;
    return this.runEngine.buildSynchronousResult({
      sessionId,
      runId: started.run_id ?? null,
      taskId: started.task_id ?? null,
      agentName: runtimeAgent.agent_name,
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
    const sessionMetadata = this.sessions.getSession(sessionId)?.metadata ?? {};
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
    if (!this.sessions.getSession(sessionId)) {
      this.sessions.createSession({ sessionId, userId: input.userId ?? null });
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
      const attachmentResolution = this.attachmentResolver.resolve(sessionId, input.attachments);
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
    const prepared = this.sessions.prepareRetry(prepareInput);

    const runtimeAgent = ready.agent;
    const started = this.runEngine.startRun({
      sessionId,
      userId: input.userId ?? null,
      requestId: input.requestId,
      task: prepared.task,
      executionKind: "rollback_and_retry",
      entrypoint: "rollback_and_retry",
      agent: runtimeAgent,
      provider: ready.provider,
      modelName: ready.modelName,
      ...(input.selectedLlm ? { selectedLlm: { provider: ready.provider, modelName: ready.modelName } } : {}),
      existingUserMessageId: prepared.message.id,
      userMessageSavedPayload: {
        id: prepared.message.id,
        seq: prepared.message.seq,
        role: prepared.message.role,
        retry_of_seq: prepared.message.seq,
        retry_of_message_id: prepared.message.id,
      },
      startStepExtra: {
        retry_of_seq: prepared.message.seq,
        retry_of_message_id: prepared.message.id,
      },
      runStartExtra: {
        retry_of_seq: prepared.message.seq,
        retry_of_message_id: prepared.message.id,
      },
      finalMetadataExtra: {
        retry_of_seq: prepared.message.seq,
        retry_of_message_id: prepared.message.id,
      },
    });
    const { promise: _promise, ...publicStarted } = started;

    return {
      ...publicStarted,
      deleted: prepared.deleted,
      agent_name: runtimeAgent.agent_name,
    };
  }

}

export function createLaunchers(deps: LauncherDeps): LauncherApi {
  const impl = new AgentLaunchers(
    deps.sessions,
    deps.conversationStore,
    deps.runtimeCore,
    deps.slashCommandHandler,
    deps.attachmentResolver,
    deps.statusTracker,
    deps.eventPublisher,
    deps.runEngine,
  );
  return {
    startStream: impl.startStream.bind(impl),
    executeSynchronously: impl.executeSynchronously.bind(impl),
    startRollbackRetry: impl.startRollbackRetry.bind(impl),
  };
}
