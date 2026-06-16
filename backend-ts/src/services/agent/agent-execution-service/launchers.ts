import { randomUUID } from "node:crypto";

import type {
  AgentExecuteResult,
  AgentRunStartResult,
  CheckpointRecoveryStartResult,
  ExecuteRequest,
  RollbackRetryStartResult,
  StreamExecuteRequest,
} from "../../../contracts/execution.js";
import { getSelectedLlm as resolveSelectedLlm } from "../../../contracts/execution.js";
import type { AgentRuntimeContextBuilder } from "../agent-runtime-context-builder.js";
import type { AgentSessionApplication } from "../agent-session-application.js";
import type { CheckpointInfo } from "../../stores/checkpoint-manager.js";
import type { ConversationStore } from "../../stores/conversation-store.js";
import type { RuntimeExecutionConfigResolver } from "../../runtime/runtime-core-service.js";
import {
  asString,
  buildRunningExecutionStatus,
  buildRunStartPayload,
  buildRunStartStepPayload,
  checkpointMessagesToConversation,
  findLatestCheckpointUserTask,
  normalizeSessionEntryAgent,
} from "./helpers.js";
import { resolveReadyAgent } from "./readiness.js";
import { appendAttachmentContext, type AttachmentResolver } from "./attachment-resolver.js";
import { parseSlashCommand, type SlashCommandHandler } from "./slash-command-handler.js";
import type { FollowupQueue } from "./followup-queue.js";
import type { AgentRunEngine } from "./run-engine.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { AgentExecutionEventPublisher } from "./event-publisher.js";

export interface RollbackRetryInput {
  sessionId: string;
  userId?: string | null;
  requestId: string;
  afterSeq?: number | null;
  afterMessageId?: string | null;
  modifyUserMessage?: string | null;
  selectedLlm?: string | null;
}

export interface CheckpointRecoveryInput {
  sessionId: string;
  userId?: string | null;
  checkpoint: CheckpointInfo;
  requestId: string;
}

export interface LauncherApi {
  startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult>;
  executeSynchronously(request: ExecuteRequest, requestId: string): Promise<AgentExecuteResult>;
  startRollbackRetry(input: RollbackRetryInput): Promise<RollbackRetryStartResult>;
  startCheckpointRecovery(input: CheckpointRecoveryInput): Promise<CheckpointRecoveryStartResult>;
}

export interface LauncherDeps {
  sessions: AgentSessionApplication;
  conversationStore: ConversationStore;
  runtimeCore: RuntimeExecutionConfigResolver;
  contextBuilder: AgentRuntimeContextBuilder;
  slashCommandHandler: SlashCommandHandler;
  attachmentResolver: AttachmentResolver;
  followupQueue: FollowupQueue;
  statusTracker: AgentExecutionStatusTracker;
  eventPublisher: AgentExecutionEventPublisher;
  runEngine: AgentRunEngine;
}

/**
 * 4 个启动入口（startStream/executeSynchronously/startRollbackRetry/startCheckpointRecovery）。
 * 方法体原样来自原 AgentExecutionService（this.xxx 字段访问保持不变）。
 */
class AgentLaunchers {
  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly conversationStore: ConversationStore,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly contextBuilder: AgentRuntimeContextBuilder,
    private readonly slashCommandHandler: SlashCommandHandler,
    private readonly attachmentResolver: AttachmentResolver,
    private readonly followupQueue: FollowupQueue,
    private readonly statusTracker: AgentExecutionStatusTracker,
    private readonly eventPublisher: AgentExecutionEventPublisher,
    private readonly runEngine: AgentRunEngine,
  ) {}

  async startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult> {
    const sessionId = request.session_id?.trim() || randomUUID();
    let task = request.task.trim();
    const slashCommand = parseSlashCommand(task);
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
      task = slashCommand.expandedTask;
    }
    if (!task && request.attachments.length === 0) {
      return {
        started: false,
        session_id: sessionId,
        error: "Task and attachments cannot both be empty",
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
    task = appendAttachmentContext(task, attachmentResolution.attachments);
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
      this.followupQueue.queue(sessionId, followupMessage.content);
      const followupPayload = {
        id: followupMessage.id,
        seq: followupMessage.seq,
        role: followupMessage.role,
        run_id: runningStatus.run_id,
        task_id: runningStatus.task_id,
        request_id: requestId,
      };
      this.eventPublisher.publishOutputMessageSaved(sessionId, runningRunId, followupPayload);
      return {
        started: true,
        session_id: sessionId,
        ...(runningRunId ? { run_id: runningRunId } : {}),
        ...(runningTaskId ? { task_id: runningTaskId } : {}),
        request_id: requestId,
        kind: "agent_run",
      };
    }

    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: normalizeSessionEntryAgent(sessionMetadata.entry_agent),
        teamName: asString(sessionMetadata.team),
        selectedLlm: resolveSelectedLlm(request),
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

    const runId = randomUUID();
    const taskId = randomUUID();
    const rootCallId = `call_${randomUUID()}`;
    const startedAt = new Date();
    const abortController = new AbortController();
    const status = buildRunningExecutionStatus({
      taskId,
      sessionId,
      runId,
      requestId,
      executionKind: "agent_stream",
      task,
      startedAt,
    });

    if (!this.sessions.getSession(sessionId)) {
      this.sessions.createSession({ sessionId, userId: request.user_id ?? null });
    }
    const runtimeAgent = ready.agent;

    this.conversationStore.createRun({
      runId,
      sessionId,
      entrypoint: "agent_stream",
      status: "running",
      taskSummary: task.slice(0, 200),
      userId: request.user_id ?? null,
      agentName: runtimeAgent.agent_name,
      threadKey: "root",
    });
    const userMessage = this.sessions.addMessage({
      sessionId,
      role: "user",
      content: task,
      metadata: {
        agent: runtimeAgent.agent_name,
        run_id: runId,
        request_id: requestId,
        execution_kind: "agent_stream",
        ...(slashCommand ? { type: "command", command: slashCommand.name, command_mode: slashCommand.mode } : {}),
        ...(attachmentResolution.attachments.length ? { file_references: attachmentResolution.attachments } : {}),
      },
    });
    const userMessageSavedPayload = {
      id: userMessage.id,
      seq: userMessage.seq,
      role: userMessage.role,
      run_id: runId,
      task_id: taskId,
      request_id: requestId,
    };
    const runStartPayload = buildRunStartPayload({
      runId,
      taskId,
      requestId,
      agent: runtimeAgent,
    });
    this.eventPublisher.publishSessionRunStarted(sessionId, runId, runStartPayload);
    this.eventPublisher.publishOutputMessageSaved(sessionId, runId, userMessageSavedPayload);

    const startStepPayload = buildRunStartStepPayload({
      rootCallId,
      runId,
      taskId,
      requestId,
      agent: runtimeAgent,
      description: task,
    });
    this.eventPublisher.publishRunStartStep(sessionId, runId, startStepPayload);

    this.eventPublisher.publishRunStart(sessionId, runId, runStartPayload);

    const promise = this.runEngine.executeRun({
      sessionId,
      runId,
      taskId,
      rootCallId,
      requestId,
      task,
      startedAt,
      abortController,
      status,
      agent: runtimeAgent,
      provider: ready.provider,
      modelName: ready.modelName,
      userMessageId: userMessage.id,
      conversationUpdateProvider: () => this.followupQueue.drain(sessionId),
    });
    this.statusTracker.register(taskId, sessionId, { abortController, status, promise });

    return {
      started: true,
      session_id: sessionId,
      run_id: runId,
      task_id: taskId,
      request_id: requestId,
      kind: "agent_run",
    };
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
    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: request.agent?.trim() || normalizeSessionEntryAgent(sessionMetadata.entry_agent),
        teamName: asString(sessionMetadata.team),
        selectedLlm: resolveSelectedLlm(request),
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

    const prepareInput: {
      sessionId: string;
      afterSeq?: number | null;
      afterMessageId?: string | null;
      modifyUserMessage?: string | null;
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
    const prepared = this.sessions.prepareRetry(prepareInput);
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
        deleted: prepared.deleted,
        error: ready.reason,
      };
    }
    if (!this.sessions.getSession(sessionId)) {
      this.sessions.createSession({ sessionId, userId: input.userId ?? null });
    }

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

  async startCheckpointRecovery(input: CheckpointRecoveryInput): Promise<CheckpointRecoveryStartResult> {
    const sessionId = input.sessionId.trim();
    const baseResult = {
      session_id: sessionId || input.sessionId,
      checkpoint_id: input.checkpoint.checkpoint_id,
      round: input.checkpoint.round,
      agent_name: input.checkpoint.agent_name,
    };
    if (!sessionId) {
      return {
        started: false,
        ...baseResult,
        error: "session_id is required",
      };
    }

    const task = findLatestCheckpointUserTask(input.checkpoint);
    if (!task) {
      return {
        started: false,
        ...baseResult,
        session_id: sessionId,
        error: "检查点中没有用户消息",
      };
    }

    const sessionMetadata = this.sessions.getSession(sessionId)?.metadata ?? {};
    const runningStatus = this.statusTracker.getStatusBySession(sessionId);
    if (runningStatus?.status === "running") {
      return {
        started: false,
        ...baseResult,
        session_id: sessionId,
        error: "该会话正在执行任务，请等待完成或停止当前任务",
      };
    }

    const ready = resolveReadyAgent(
      this.runtimeCore,
      {
        agentName: normalizeSessionEntryAgent(input.checkpoint.agent_name),
        teamName: asString(sessionMetadata.team),
      },
      sessionMetadata,
    );
    if (!ready.ok) {
      return {
        started: false,
        ...baseResult,
        session_id: sessionId,
        error: ready.reason,
      };
    }

    if (!this.sessions.getSession(sessionId)) {
      this.sessions.createSession({ sessionId, userId: input.userId ?? null });
    }

    const runtimeAgent = ready.agent;
    const runId = randomUUID();
    const taskId = randomUUID();
    const rootCallId = `call_${randomUUID()}`;
    const startedAt = new Date();
    const abortController = new AbortController();
    const executionKind = "checkpoint_recovery";
    const status = buildRunningExecutionStatus({
      taskId,
      sessionId,
      runId,
      requestId: input.requestId,
      executionKind,
      task,
      startedAt,
    });
    const baseContext = this.contextBuilder.buildContext({
      sessionId,
      agent: runtimeAgent,
      historyLimit: 0,
    });
    const recoveryConversation = [
      ...baseContext.conversation,
      ...checkpointMessagesToConversation(input.checkpoint.messages),
    ];

    this.conversationStore.createRun({
      runId,
      sessionId,
      entrypoint: executionKind,
      status: "running",
      taskSummary: task.slice(0, 200),
      userId: input.userId ?? null,
      agentName: runtimeAgent.agent_name,
      threadKey: "root",
    });

    const startStepPayload = buildRunStartStepPayload({
      rootCallId,
      runId,
      taskId,
      requestId: input.requestId,
      agent: runtimeAgent,
      description: task,
      executionKind,
      recoveredFrom: input.checkpoint.checkpoint_id,
      checkpointId: input.checkpoint.checkpoint_id,
      checkpointRound: input.checkpoint.round,
    });
    const runStartPayload = buildRunStartPayload({
      runId,
      taskId,
      requestId: input.requestId,
      agent: runtimeAgent,
      executionKind,
      recoveredFrom: input.checkpoint.checkpoint_id,
    });
    this.eventPublisher.publishSessionRunStarted(sessionId, runId, runStartPayload);
    this.eventPublisher.publishRunStartStep(sessionId, runId, startStepPayload);
    this.eventPublisher.publishRunStart(sessionId, runId, runStartPayload);

    const promise = this.runEngine.executeRun({
      sessionId,
      runId,
      taskId,
      rootCallId,
      requestId: input.requestId,
      task,
      startedAt,
      abortController,
      status,
      agent: runtimeAgent,
      provider: ready.provider,
      modelName: ready.modelName,
      executionKind,
      contextConversation: recoveryConversation,
      stablePrefixFingerprint: baseContext.metadata.stable_prefix_fingerprint,
      finalMetadataExtra: {
        recovered_from: input.checkpoint.checkpoint_id,
        checkpoint_id: input.checkpoint.checkpoint_id,
        checkpoint_round: input.checkpoint.round,
      },
    });
    this.statusTracker.register(taskId, sessionId, { abortController, status, promise });

    return {
      started: true,
      session_id: sessionId,
      run_id: runId,
      task_id: taskId,
      request_id: input.requestId,
      kind: "agent_run",
      checkpoint_id: input.checkpoint.checkpoint_id,
      round: input.checkpoint.round,
      agent_name: runtimeAgent.agent_name,
    };
  }
}

export function createLaunchers(deps: LauncherDeps): LauncherApi {
  const impl = new AgentLaunchers(
    deps.sessions,
    deps.conversationStore,
    deps.runtimeCore,
    deps.contextBuilder,
    deps.slashCommandHandler,
    deps.attachmentResolver,
    deps.followupQueue,
    deps.statusTracker,
    deps.eventPublisher,
    deps.runEngine,
  );
  return {
    startStream: impl.startStream.bind(impl),
    executeSynchronously: impl.executeSynchronously.bind(impl),
    startRollbackRetry: impl.startRollbackRetry.bind(impl),
    startCheckpointRecovery: impl.startCheckpointRecovery.bind(impl),
  };
}
