import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../../contracts/agent-config.js";
import type {
  AgentExecuteResult,
  AgentRunStartResult,
  CollaborateRequest,
  CheckpointRecoveryStartResult,
  ExecuteRequest,
  ExecutionOverview,
  ExecutionTaskStatus,
  RollbackRetryStartResult,
  RunningTasksResult,
  ScopedExecutionDiagnostics,
  ScopedTaskStatus,
  SessionTaskStatus,
  StreamExecuteRequest,
} from "../../contracts/execution.js";
import { getSelectedLlm as resolveSelectedLlm } from "../../contracts/execution.js";
import type { ModelProviderConfig } from "../../contracts/model-adapter.js";
import type { AgentContextCompressionService } from "./agent-context-compression-service.js";
import type { AgentSessionApplication } from "./agent-session-application.js";
import type { AgentRuntimeContextBuilder } from "./agent-runtime-context-builder.js";
import type { AttachmentRef } from "../../contracts/execution.js";
import type { CheckpointInfo } from "../stores/checkpoint-manager.js";
import type { ConversationStore } from "../stores/conversation-store.js";
import type { FileIndexService } from "../stores/file-index-service.js";
import type { AgentRuntimeCore } from "./agent-runtime-core.js";
import type { BackgroundTaskService } from "../runtime/background-task-service.js";
import { buildAgentPromptContext, type AgentPromptConfigResolver } from "./agent-prompt-builder.js";
import type { ChatMessage } from "../integrations/llm-chat-client.js";
import { renderSemanticBlock } from "../runtime/runtime-xml-protocol.js";
import type { RuntimeExecutionConfigResolver } from "../runtime/runtime-core-service.js";
import type { RuntimeToolExecutor } from "../runtime/runtime-tool-types.js";
import type { OutboxDispatcher } from "../runtime/event-outbox/dispatcher.js";
import type { DurableClientEventPublisher } from "../runtime/event-outbox/client-event-publisher.js";
import { AgentExecutionEventPublisher } from "./agent-execution-service/event-publisher.js";
import { ExecutionRecorder, type RunTerminalRecord } from "./agent-execution-service/recorder.js";
import { AgentExecutionStatusTracker } from "./agent-execution-service/status-tracker.js";
import {
  applySessionAgentOverrides,
  asString,
  buildContextUsagePayload,
  buildFinalStepPayload,
  buildRunningExecutionStatus,
  buildRunEndStepPayload,
  buildRunStartPayload,
  buildRunStartStepPayload,
  buildRuntimeToolContext,
  checkpointMessagesToConversation,
  findLatestCheckpointUserTask,
  mirrorEventData,
  normalizeSessionEntryAgent,
  renderBackgroundNotification,
  resolveLegacyContextBudget,
  summarizeReadinessFailure,
} from "./agent-execution-service/helpers.js";

export interface AgentExecutionServiceOptions {
  outboxDispatcher?: Pick<OutboxDispatcher, "dispatchRows"> | undefined;
  clientEvents?: DurableClientEventPublisher | undefined;
  logger?: AgentExecutionLogger | undefined;
}

export interface AgentExecutionLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export class AgentExecutionService {
  private readonly statusTracker = new AgentExecutionStatusTracker();
  private readonly pendingFollowupsBySession = new Map<string, ChatMessage[]>();
  private readonly eventPublisher: AgentExecutionEventPublisher;
  private readonly executionRecorder: ExecutionRecorder;
  private readonly outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">;
  private readonly clientEvents: DurableClientEventPublisher;
  private readonly logger: AgentExecutionLogger | null;

  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly conversationStore: ConversationStore,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly agentRuntimeCore: AgentRuntimeCore,
    private readonly contextBuilder: AgentRuntimeContextBuilder,
    private readonly runtimeTools: RuntimeToolExecutor | null = null,
    private readonly contextCompression: AgentContextCompressionService | null = null,
    private readonly promptConfigResolver: AgentPromptConfigResolver | null = null,
    private readonly backgroundTasks: BackgroundTaskService | null = null,
    private readonly fileIndex: FileIndexService | null = null,
    options: AgentExecutionServiceOptions = {},
  ) {
    if (!options.clientEvents) {
      throw new Error("AgentExecutionService requires a durable client event publisher");
    }
    if (!options.outboxDispatcher) {
      throw new Error("AgentExecutionService requires an outbox dispatcher");
    }
    this.clientEvents = options.clientEvents;
    this.eventPublisher = new AgentExecutionEventPublisher(sessions, this.clientEvents, conversationStore);
    this.executionRecorder = new ExecutionRecorder(conversationStore);
    this.outboxDispatcher = options.outboxDispatcher;
    this.logger = options.logger ?? null;
  }

  async startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult> {
    const sessionId = request.session_id?.trim() || randomUUID();
    let task = request.task.trim();
    const slashCommand = parseSlashCommand(task);
    if (slashCommand) {
      const commandResult = await this.handleSlashCommand({
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
    const attachmentResolution = this.resolveAttachments(sessionId, request.attachments);
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
      this.queueFollowup(sessionId, followupMessage.content);
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

    const resolved = this.runtimeCore.resolveExecutionConfig({
      agentName: normalizeSessionEntryAgent(sessionMetadata.entry_agent),
      teamName: asString(sessionMetadata.team),
      selectedLlm: resolveSelectedLlm(request),
    });
    if (!resolved.readiness.configuration_ready || !resolved.agent || !resolved.provider || !resolved.modelName) {
      return {
        started: false,
        session_id: sessionId,
        error: summarizeReadinessFailure(resolved.readiness.requirements),
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
    const runtimeAgent = applySessionAgentOverrides(resolved.agent, sessionMetadata);

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

    const promise = this.runMinimalAgent({
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
        provider: resolved.provider,
        modelName: resolved.modelName,
        userMessageId: userMessage.id,
        conversationUpdateProvider: () => this.drainFollowups(sessionId),
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

  async stopSession(sessionId: string): Promise<boolean> {
    const handle = this.statusTracker.getRunningHandleBySession(sessionId);
    if (!handle) {
      return false;
    }
    this.eventPublisher.publishUserInterrupt(handle.status, "user_stop");
    handle.abortController.abort();
    return true;
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
    const resolved = this.runtimeCore.resolveExecutionConfig({
      agentName: request.agent?.trim() || normalizeSessionEntryAgent(sessionMetadata.entry_agent),
      teamName: asString(sessionMetadata.team),
      selectedLlm: resolveSelectedLlm(request),
    });
    if (!resolved.readiness.configuration_ready || !resolved.agent || !resolved.provider || !resolved.modelName) {
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
        error: summarizeReadinessFailure(resolved.readiness.requirements),
      };
    }

    const runtimeAgent = applySessionAgentOverrides(resolved.agent, sessionMetadata);
    const started = this.startAgentRun({
      sessionId,
      userId: request.user_id ?? null,
      requestId,
      task,
      executionKind: "execute",
      entrypoint: "execute",
      agent: runtimeAgent,
      provider: resolved.provider,
      modelName: resolved.modelName,
      persistUserMessage: {
        metadata: {
          agent: runtimeAgent.agent_name,
          request_id: requestId,
          execution_kind: "execute",
        },
      },
    });
    await started.promise;
    return this.buildSynchronousResult({
      sessionId,
      runId: started.run_id ?? null,
      taskId: started.task_id ?? null,
      agentName: runtimeAgent.agent_name,
    });
  }

  async collaborateSequentially(request: CollaborateRequest, requestId: string): Promise<{
    results: AgentExecuteResult[];
    session_id: string;
    total_tasks: number;
  }> {
    const sessionId = request.session_id?.trim() || randomUUID();
    const results: AgentExecuteResult[] = [];
    for (const [index, taskItem] of request.tasks.entries()) {
      const executeRequest: ExecuteRequest = {
        task: taskItem.task,
        session_id: sessionId,
        user_id: request.user_id ?? null,
        attachments: [],
      };
      if (taskItem.agent !== undefined) {
        executeRequest.agent = taskItem.agent;
      }
      const result = await this.executeSynchronously(
        executeRequest,
        `${requestId}:${index + 1}`,
      );
      results.push(result);
      if (!result.success) {
        break;
      }
    }
    return {
      results,
      session_id: sessionId,
      total_tasks: request.tasks.length,
    };
  }

  async startRollbackRetry(input: {
    sessionId: string;
    userId?: string | null;
    requestId: string;
    afterSeq?: number | null;
    afterMessageId?: string | null;
    modifyUserMessage?: string | null;
    selectedLlm?: string | null;
  }): Promise<RollbackRetryStartResult> {
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
    const resolved = this.runtimeCore.resolveExecutionConfig(resolveInput);
    if (!resolved.readiness.configuration_ready || !resolved.agent || !resolved.provider || !resolved.modelName) {
      return {
        started: false,
        session_id: sessionId,
        deleted: prepared.deleted,
        error: summarizeReadinessFailure(resolved.readiness.requirements),
      };
    }
    if (!this.sessions.getSession(sessionId)) {
      this.sessions.createSession({ sessionId, userId: input.userId ?? null });
    }

    const runtimeAgent = applySessionAgentOverrides(resolved.agent, sessionMetadata);
    const started = this.startAgentRun({
      sessionId,
      userId: input.userId ?? null,
      requestId: input.requestId,
      task: prepared.task,
      executionKind: "rollback_and_retry",
      entrypoint: "rollback_and_retry",
      agent: runtimeAgent,
      provider: resolved.provider,
      modelName: resolved.modelName,
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

  getSessionTaskStatus(sessionId: string): SessionTaskStatus {
    return this.statusTracker.getSessionTaskStatus(sessionId);
  }

  getSessionExecutionDiagnostics(sessionId: string): ScopedExecutionDiagnostics {
    return this.statusTracker.getSessionExecutionDiagnostics(sessionId);
  }

  getTaskStatus(taskId: string): ScopedTaskStatus {
    return this.statusTracker.getTaskStatus(taskId);
  }

  getTaskExecutionDiagnostics(taskId: string): ScopedExecutionDiagnostics {
    return this.statusTracker.getTaskExecutionDiagnostics(taskId);
  }

  listRunningTasks(): RunningTasksResult {
    return this.statusTracker.listRunningTasks();
  }

  getOverview(activeOnly: boolean): ExecutionOverview {
    return this.statusTracker.getOverview(activeOnly);
  }

  async startCheckpointRecovery(input: {
    sessionId: string;
    userId?: string | null;
    checkpoint: CheckpointInfo;
    requestId: string;
  }): Promise<CheckpointRecoveryStartResult> {
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

    const resolved = this.runtimeCore.resolveExecutionConfig({
      agentName: normalizeSessionEntryAgent(input.checkpoint.agent_name),
      teamName: asString(sessionMetadata.team),
    });
    if (!resolved.readiness.configuration_ready || !resolved.agent || !resolved.provider || !resolved.modelName) {
      return {
        started: false,
        ...baseResult,
        session_id: sessionId,
        error: summarizeReadinessFailure(resolved.readiness.requirements),
      };
    }

    if (!this.sessions.getSession(sessionId)) {
      this.sessions.createSession({ sessionId, userId: input.userId ?? null });
    }

    const runtimeAgent = applySessionAgentOverrides(resolved.agent, sessionMetadata);
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

    const promise = this.runMinimalAgent({
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
      provider: resolved.provider,
      modelName: resolved.modelName,
      executionKind,
      contextConversation: recoveryConversation,
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

  private startAgentRun(input: {
    sessionId: string;
    userId?: string | null;
    requestId: string;
    task: string;
    executionKind: string;
    entrypoint?: string | undefined;
    agent: AgentConfig;
    provider: ModelProviderConfig;
    modelName: string;
    existingUserMessageId?: string | undefined;
    userMessageSavedPayload?: Record<string, unknown> | undefined;
    persistUserMessage?: {
      metadata?: Record<string, unknown> | undefined;
    } | undefined;
    runStartExtra?: Record<string, unknown> | undefined;
    startStepExtra?: Record<string, unknown> | undefined;
    contextConversation?: ChatMessage[] | undefined;
    conversationUpdateProvider?: (() => Promise<ChatMessage[]> | ChatMessage[]) | undefined;
    finalMetadataExtra?: Record<string, unknown> | undefined;
  }): AgentRunStartResult & { promise: Promise<void> } {
    const runId = randomUUID();
    const taskId = randomUUID();
    const rootCallId = `call_${randomUUID()}`;
    const startedAt = new Date();
    const abortController = new AbortController();
    const status = buildRunningExecutionStatus({
      taskId,
      sessionId: input.sessionId,
      runId,
      requestId: input.requestId,
      executionKind: input.executionKind,
      task: input.task,
      startedAt,
    });

    this.conversationStore.createRun({
      runId,
      sessionId: input.sessionId,
      entrypoint: input.entrypoint ?? input.executionKind,
      status: "running",
      taskSummary: input.task.slice(0, 200),
      userId: input.userId ?? null,
      agentName: input.agent.agent_name,
      threadKey: "root",
    });
    let userMessageSavedPayload = input.userMessageSavedPayload;
    let existingUserMessageId = input.existingUserMessageId;
    if (input.persistUserMessage) {
      const userMessage = this.sessions.addMessage({
        sessionId: input.sessionId,
        role: "user",
        content: input.task,
        metadata: {
          ...(input.persistUserMessage.metadata ?? {}),
          agent: input.agent.agent_name,
          run_id: runId,
          task_id: taskId,
          request_id: input.requestId,
          execution_kind: input.executionKind,
        },
      });
      existingUserMessageId = userMessage.id;
      userMessageSavedPayload = {
        id: userMessage.id,
        seq: userMessage.seq,
        role: userMessage.role,
      };
    }

    const runStartPayload = {
      ...buildRunStartPayload({
        runId,
        taskId,
        requestId: input.requestId,
        agent: input.agent,
        executionKind: input.executionKind,
      }),
      ...(input.runStartExtra ?? {}),
    };
    const startStepPayload = {
      ...buildRunStartStepPayload({
        rootCallId,
        runId,
        taskId,
        requestId: input.requestId,
        agent: input.agent,
        description: input.task,
        executionKind: input.executionKind,
      }),
      ...(input.startStepExtra ?? {}),
    };

    this.eventPublisher.publishSessionRunStarted(input.sessionId, runId, runStartPayload);
    if (userMessageSavedPayload) {
      this.eventPublisher.publishOutputMessageSaved(input.sessionId, runId, {
        ...userMessageSavedPayload,
        run_id: runId,
        task_id: taskId,
        request_id: input.requestId,
        execution_kind: input.executionKind,
      });
    }
    this.eventPublisher.publishRunStartStep(input.sessionId, runId, startStepPayload);
    this.eventPublisher.publishRunStart(input.sessionId, runId, runStartPayload);

    const promise = this.runMinimalAgent({
      sessionId: input.sessionId,
      runId,
      taskId,
      rootCallId,
      requestId: input.requestId,
      task: input.task,
      startedAt,
      abortController,
      status,
      agent: input.agent,
      provider: input.provider,
      modelName: input.modelName,
      userMessageId: existingUserMessageId,
      conversationUpdateProvider: input.conversationUpdateProvider,
      executionKind: input.executionKind,
      contextConversation: input.contextConversation,
      finalMetadataExtra: input.finalMetadataExtra,
    });
    this.statusTracker.register(taskId, input.sessionId, { abortController, status, promise });

    return {
      started: true,
      session_id: input.sessionId,
      run_id: runId,
      task_id: taskId,
      request_id: input.requestId,
      kind: "agent_run",
      promise,
    };
  }

  private buildSynchronousResult(input: {
    sessionId: string;
    runId: string | null;
    taskId: string | null;
    agentName: string;
  }): AgentExecuteResult {
    if (!input.runId) {
      return {
        success: false,
        answer: null,
        agent_name: input.agentName,
        execution_time: null,
        tool_calls: [],
        metadata: {},
        session_id: input.sessionId,
        run_id: null,
        task_id: input.taskId,
        error: "运行未启动",
      };
    }
    const run = this.conversationStore.getRun(input.sessionId, input.runId);
    const finalMessage = run?.final_message_id
      ? this.conversationStore.getMessageById(input.sessionId, run.final_message_id)
      : null;
    const steps = this.conversationStore.listRunSteps({
      sessionId: input.sessionId,
      runId: input.runId,
      limit: 1000,
    });
    const toolCalls = steps
      .map((step) => step.payload)
      .filter((payload) => payload.kind === "tool" && payload.phase === "end");
    const lastRunEnd = [...steps]
      .reverse()
      .map((step) => step.payload)
      .find((payload) => payload.kind === "run" && payload.phase === "end");
    const executionTime = numberOrNull(finalMessage?.metadata.execution_time);
    const error = asString(lastRunEnd?.error) ?? (run?.status && run.status !== "completed" ? asString(lastRunEnd?.result_preview) : null);
    const metadata = {
      ...(finalMessage?.metadata ?? {}),
      run_id: input.runId,
      thread_key: run?.thread_key ?? "root",
      child_agent_id: run?.child_agent_id ?? null,
    };

    return {
      success: run?.status === "completed" && Boolean(finalMessage),
      answer: finalMessage?.content ?? null,
      agent_name: run?.agent_name ?? input.agentName,
      execution_time: executionTime,
      tool_calls: toolCalls,
      metadata,
      session_id: input.sessionId,
      run_id: input.runId,
      task_id: input.taskId,
      error: run?.status === "completed" ? null : error ?? "任务执行失败",
    };
  }

  private async runMinimalAgent(input: {
    sessionId: string;
    runId: string;
    taskId: string;
    rootCallId: string;
    requestId: string;
    task: string;
    startedAt: Date;
    abortController: AbortController;
    status: ExecutionTaskStatus;
    agent: AgentConfig;
    provider: ModelProviderConfig;
    modelName: string;
    userMessageId?: string | undefined;
    conversationUpdateProvider?: (() => Promise<ChatMessage[]> | ChatMessage[]) | undefined;
    executionKind?: string | undefined;
    contextConversation?: ChatMessage[] | undefined;
    finalMetadataExtra?: Record<string, unknown> | undefined;
  }): Promise<void> {
    try {
      const sessionMetadata = this.sessions.getSession(input.sessionId)?.metadata ?? {};
      const executionKind = input.executionKind ?? "agent_stream";
      this.eventPublisher.publishRootAgentStart({
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        rootCallId: input.rootCallId,
        agent: input.agent,
        task: input.task,
      });
      const compressionResult =
        input.contextConversation !== undefined || !this.contextCompression
          ? null
          : await this.contextCompression.compressIfNeeded({
              sessionId: input.sessionId,
              runId: input.runId,
              taskId: input.taskId,
              requestId: input.requestId,
              agent: input.agent,
              provider: input.provider,
              modelName: input.modelName,
              threadKey: "root",
              signal: input.abortController.signal,
              onEvent: (event) => this.eventPublisher.publishContextCompressionEvent(input, event),
            });
      const pendingBackgroundNotifications = this.drainBackgroundTaskNotifications(input.sessionId);
      const context = input.contextConversation
        ? { conversation: [...input.contextConversation, ...pendingBackgroundNotifications] }
        : this.contextBuilder.buildContext({
            sessionId: input.sessionId,
            agent: input.agent,
            microcompact: true,
          });
      if (input.contextConversation === undefined && pendingBackgroundNotifications.length) {
        context.conversation.push(...pendingBackgroundNotifications);
      }
      const teamName = asString(sessionMetadata.team);
      const promptContext = buildAgentPromptContext({
        agent: input.agent,
        toolExecutor: this.runtimeTools,
        configResolver: this.promptConfigResolver,
        teamName,
      });
      const contextUsagePayload = buildContextUsagePayload({
        agent: input.agent,
        promptContext,
        budgetTokens: this.resolveContextBudget(input.agent, input.provider),
        messages: context.conversation,
        round: 0,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        compressionResult,
      });
      this.clientEvents.publish(input.sessionId, {
        type: "context.usage",
        session_id: input.sessionId,
        run_id: input.runId,
        agent_name: input.agent.agent_name,
        ...mirrorEventData(contextUsagePayload),
      });
      const response = await this.agentRuntimeCore.runText({
        agent: input.agent,
        provider: input.provider,
        modelName: input.modelName,
        signal: input.abortController.signal,
        conversation: context.conversation,
        conversationUpdateProvider: () => this.drainConversationUpdates(input.sessionId, input.conversationUpdateProvider),
        toolExecutor: this.runtimeTools ?? undefined,
        promptContext,
        toolContext: this.runtimeTools
          ? buildRuntimeToolContext(input.agent, {
              sessionId: input.sessionId,
              runId: input.runId,
              taskId: input.taskId,
              requestId: input.requestId,
              sessionMetadata,
              parentCallId: input.rootCallId,
              signal: input.abortController.signal,
            })
          : undefined,
        onEvent: async (event) => {
          this.eventPublisher.publishRuntimeEvent(input, event);
        },
      });
      const assistantMessageId = randomUUID();
      const assistantMessageMetadata = {
        agent: input.agent.agent_name,
        run_id: input.runId,
        request_id: input.requestId,
        msg_type: "assistant_final",
        execution_kind: executionKind,
        ...(input.finalMetadataExtra ?? {}),
      };
      this.statusTracker.finishStatus(input.status, "completed", input.startedAt);
      const finalMetadata = {
        agent: input.agent.agent_name,
        run_id: input.runId,
        request_id: input.requestId,
        execution_kind: executionKind,
        execution_time: input.status.elapsed_seconds,
        ...(input.finalMetadataExtra ?? {}),
      };
      const finalStepPayload = buildFinalStepPayload({
        rootCallId: input.rootCallId,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        agent: input.agent,
        messageId: assistantMessageId,
        resultPreview: response.content.slice(0, 500),
      });
      const runEndStepPayload = buildRunEndStepPayload({
        rootCallId: input.rootCallId,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        agent: input.agent,
        status: "completed",
        resultPreview: response.content.slice(0, 500),
      });
      const terminalRecord = this.executionRecorder.recordRunTerminal({
        status: "completed",
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        rootCallId: input.rootCallId,
        agentName: input.agent.agent_name,
        agentDisplayName: input.agent.display_name || input.agent.agent_name,
        finalMessage: {
          id: assistantMessageId,
          content: response.content,
          metadata: assistantMessageMetadata,
        },
        finalStepPayload,
        runEndStepPayload,
        finalMetadata,
      });
      const assistantMessage = terminalRecord.message;
      if (!assistantMessage) {
        throw new Error(`Completed run did not record assistant message: ${input.runId}`);
      }
      this.deliverTerminalRecord(terminalRecord);
    } catch (error) {
      const interrupted = input.abortController.signal.aborted;
      const finalStatus = interrupted ? "interrupted" : "failed";
      const errorMessage = error instanceof Error ? error.message : String(error);
      const executionKind = input.executionKind ?? "agent_stream";
      if (!interrupted) {
        this.logger?.error({
          ...serializeErrorForLog(error),
          session_id: input.sessionId,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
          agent_name: input.agent.agent_name,
          provider_key: input.provider.key ?? null,
          provider_name: input.provider.name,
          provider_type: input.provider.provider_type,
          model_name: input.modelName,
          execution_kind: executionKind,
        }, "agent runtime execution failed");
      }
      this.statusTracker.finishStatus(input.status, finalStatus, input.startedAt);
      const finalMetadata = {
        agent: input.agent.agent_name,
        run_id: input.runId,
        request_id: input.requestId,
        execution_kind: executionKind,
        execution_time: input.status.elapsed_seconds,
        ...(input.finalMetadataExtra ?? {}),
      };
      const runEndStepPayload = buildRunEndStepPayload({
        rootCallId: input.rootCallId,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        agent: input.agent,
        status: interrupted ? "interrupted" : "error",
        resultPreview: interrupted ? "[已停止生成]" : errorMessage,
        error: errorMessage,
      });
      const terminalRecord = this.executionRecorder.recordRunTerminal({
        status: finalStatus,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        rootCallId: input.rootCallId,
        agentName: input.agent.agent_name,
        agentDisplayName: input.agent.display_name || input.agent.agent_name,
        errorMessage,
        errorType: interrupted ? "InterruptedError" : "ExecutionError",
        agentResult: interrupted ? "[已停止生成]" : errorMessage,
        runEndStepPayload,
        finalMetadata,
      });
      this.deliverTerminalRecord(terminalRecord);
    } finally {
      this.statusTracker.unregister(input.taskId, input.sessionId);
    }
  }

  private deliverTerminalRecord(record: RunTerminalRecord): void {
    this.outboxDispatcher.dispatchRows(record.outboxRows);
  }

  private queueFollowup(sessionId: string, content: string): void {
    const followups = this.pendingFollowupsBySession.get(sessionId) ?? [];
    followups.push({
      role: "user",
      content: renderSemanticBlock("user_followup", content, { source: "running_session" }),
    });
    this.pendingFollowupsBySession.set(sessionId, followups);
  }

  private drainFollowups(sessionId: string): ChatMessage[] {
    const followups = this.pendingFollowupsBySession.get(sessionId);
    if (!followups?.length) {
      return [];
    }
    this.pendingFollowupsBySession.delete(sessionId);
    return followups.map((message) => ({ ...message }));
  }

  private async drainConversationUpdates(
    sessionId: string,
    provider?: (() => Promise<ChatMessage[]> | ChatMessage[]) | undefined,
  ): Promise<ChatMessage[]> {
    const notifications = this.drainBackgroundTaskNotifications(sessionId);
    const updates = provider ? await provider() : [];
    return [...notifications, ...updates];
  }

  private drainBackgroundTaskNotifications(sessionId: string): ChatMessage[] {
    const payloads = this.backgroundTasks?.drainPendingNotifications(sessionId) ?? [];
    return payloads
      .map((payload) => renderBackgroundNotification(payload))
      .filter((content) => content.trim())
      .map((content) => ({ role: "user", content }));
  }

  private resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig): number {
    return this.contextCompression?.resolveContextBudget(agent, provider) ?? resolveLegacyContextBudget(agent, provider);
  }

  private handleSlashCommand(input: {
    sessionId: string;
    userId: string | null;
    requestId: string;
    selectedLlm: string;
    command: ParsedSlashCommand;
    originalTask: string;
  }): Promise<AgentRunStartResult | null> {
    if (input.command.mode === "prompt") {
      return Promise.resolve(null);
    }
    return this.executeSystemSlashCommand(input);
  }

  private async executeSystemSlashCommand(input: {
    sessionId: string;
    userId: string | null;
    requestId: string;
    selectedLlm: string;
    command: ParsedSlashCommand;
    originalTask: string;
  }): Promise<AgentRunStartResult> {
    if (!this.sessions.getSession(input.sessionId)) {
      this.sessions.createSession({ sessionId: input.sessionId, userId: input.userId });
    }
    this.sessions.addMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.originalTask,
      metadata: {
        type: "command",
        command: input.command.name,
        command_mode: input.command.mode,
      },
    });
    const result = await this.resolveSystemSlashCommandResult(input);
    const message = this.sessions.addMessage({
      sessionId: input.sessionId,
      role: "system",
      content: result.content,
      metadata: {
        type: "command_result",
        command: result.command,
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
      },
    });
    this.clientEvents.publish(input.sessionId, {
      type: "command.result",
      session_id: input.sessionId,
      data: {
        command: result.command,
        success: result.success,
        content: result.content,
        ...(result.error ? { error: result.error } : {}),
        ...(result.data !== undefined ? { data: result.data } : {}),
        message_id: message.id,
      },
    }, {
      aggregateType: "session",
      aggregateId: input.sessionId,
    });
    return {
      started: result.success,
      session_id: input.sessionId,
      kind: "command",
    };
  }

  private async resolveSystemSlashCommandResult(input: {
    sessionId: string;
    requestId: string;
    selectedLlm: string;
    command: ParsedSlashCommand;
  }): Promise<SystemSlashCommandResult> {
    if (input.command.name !== "compact") {
      return executeStaticSystemSlashCommand(input.command);
    }
    const runningStatus = this.statusTracker.getStatusBySession(input.sessionId);
    if (runningStatus?.status === "running" || runningStatus?.status === "pending") {
      return {
        command: "compact",
        success: false,
        content: "该会话正在执行任务，请等待完成后再压缩",
      };
    }
    if (!this.contextCompression) {
      return {
        command: "compact",
        success: false,
        content: "当前 TypeScript runtime 未启用上下文压缩服务",
        error: "compression_unavailable",
      };
    }
    const sessionMetadata = this.sessions.getSession(input.sessionId)?.metadata ?? {};
    const resolved = this.runtimeCore.resolveExecutionConfig({
      agentName: normalizeSessionEntryAgent(sessionMetadata.entry_agent),
      teamName: asString(sessionMetadata.team),
      selectedLlm: input.selectedLlm,
    });
    if (!resolved.readiness.configuration_ready || !resolved.agent || !resolved.provider || !resolved.modelName) {
      return {
        command: "compact",
        success: false,
        content: summarizeReadinessFailure(resolved.readiness.requirements),
        error: "runtime_not_ready",
      };
    }
    try {
      const result = await this.contextCompression.forceCompactSession({
        sessionId: input.sessionId,
        agent: applySessionAgentOverrides(resolved.agent, sessionMetadata),
        provider: resolved.provider,
        modelName: resolved.modelName,
        requestId: input.requestId,
        onEvent: (event) => {
          this.clientEvents.publish(input.sessionId, {
            type: event.type,
            session_id: input.sessionId,
            agent_name: resolved.agent?.agent_name,
            ...mirrorEventData(event.data),
          }, {
            aggregateType: "session",
            aggregateId: input.sessionId,
          });
        },
      });
      if (result.status === "skipped") {
        return {
          command: "compact",
          success: true,
          content: "无需压缩（历史为空或消息不足）",
          data: result,
        };
      }
      return {
        command: "compact",
        success: true,
        content: `压缩完成：${result.before} → ${result.after} 条消息，节省 ${result.tokens_saved} tokens`,
        data: result,
      };
    } catch (error) {
      return {
        command: "compact",
        success: false,
        content: `压缩失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private resolveAttachments(
    sessionId: string,
    attachments: AttachmentRef[],
  ): { attachments: ResolvedAttachment[]; error?: string } {
    if (!attachments.length) {
      return { attachments: [] };
    }
    if (!this.fileIndex) {
      return { attachments: [], error: "Attachments are not supported by this TypeScript runtime instance" };
    }
    const resolved: ResolvedAttachment[] = [];
    for (const attachment of attachments) {
      const fileId = attachment.file_id.trim();
      if (!fileId) {
        return { attachments: [], error: "附件 file_id 不能为空" };
      }
      const record = this.fileIndex.get(fileId, "session", sessionId);
      if (!record) {
        return { attachments: [], error: `附件不存在或不属于当前会话: ${fileId}` };
      }
      resolved.push({
        file_id: record.id,
        original_name: record.original_name,
        stored_name: record.stored_name,
        stored_path: record.stored_path,
        mime: record.mime || attachment.mime || "",
        size: record.size,
        kind: attachment.kind ?? (record.mime.startsWith("image/") ? "image" : "file"),
      });
    }
    return { attachments: resolved };
  }
}

interface ResolvedAttachment {
  file_id: string;
  original_name: string;
  stored_name: string;
  stored_path: string;
  mime: string;
  size: number;
  kind: string;
}

interface ParsedSlashCommand {
  name: string;
  args: string;
  mode: "system" | "prompt";
  expandedTask: string;
}

const PROMPT_SLASH_COMMANDS: Record<string, { description: string; template: string }> = {
  review: {
    description: "代码审查",
    template: "请对以下内容进行全面的代码审查，包括代码质量、安全性和性能优化建议：{args}",
  },
  analyze: {
    description: "深度分析",
    template: "请深入分析以下问题，给出详细的技术分析和建议：{args}",
  },
  explain: {
    description: "详细解释",
    template: "请详细解释以下概念或代码，用通俗易懂的方式：{args}",
  },
};

interface SystemSlashCommandResult {
  command: string;
  success: boolean;
  content: string;
  error?: string;
  data?: unknown;
}

function parseSlashCommand(task: string): ParsedSlashCommand | null {
  const trimmed = task.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [rawCommand = "", ...rest] = trimmed.split(/\s+/);
  const name = rawCommand.slice(1).toLowerCase();
  const args = rest.join(" ").trim();
  if (name === "help" || name === "compact") {
    return {
      name,
      args,
      mode: "system",
      expandedTask: "",
    };
  }
  const promptCommand = PROMPT_SLASH_COMMANDS[name];
  if (!promptCommand) {
    return {
      name,
      args,
      mode: "system",
      expandedTask: "",
    };
  }
  if (!args) {
    return {
      name,
      args,
      mode: "system",
      expandedTask: "",
    };
  }
  return {
    name,
    args,
    mode: "prompt",
    expandedTask: promptCommand.template.replace("{args}", args),
  };
}

function executeStaticSystemSlashCommand(command: ParsedSlashCommand): SystemSlashCommandResult {
  if (command.name === "help") {
    const lines = [
      "可用命令：",
      "",
      "  /help          [系统] 显示可用命令列表",
      "  /compact       [系统] 强制压缩上下文",
      "  /review        [提示词] 代码审查",
      "  /analyze       [提示词] 深度分析",
      "  /explain       [提示词] 详细解释",
      "",
      "提示词命令后跟内容，如: /review 当前仓库代码",
    ];
    return { command: "help", success: true, content: lines.join("\n") };
  }
  const promptCommand = PROMPT_SLASH_COMMANDS[command.name];
  if (promptCommand && !command.args.trim()) {
    return {
      command: command.name,
      success: false,
      content: `用法: /${command.name} <内容>\n${promptCommand.description}`,
      error: "missing_args",
    };
  }
  return {
    command: command.name || "unknown",
    success: false,
    content: `未知命令: /${command.name}\n输入 /help 查看可用命令`,
    error: "unknown_command",
  };
}

function appendAttachmentContext(task: string, attachments: ResolvedAttachment[]): string {
  if (!attachments.length) {
    return task;
  }
  const lines = ["[普通文件附件引用]"];
  for (const attachment of attachments) {
    lines.push(
      `- file_id=${attachment.file_id} | name=${attachment.original_name || attachment.stored_name || "attachment"} | mime=${attachment.mime || "unknown"} | size=${attachment.size} | file_path=${attachment.stored_path}`,
    );
  }
  const suffix = lines.join("\n");
  return task ? `${task}\n\n${suffix}` : suffix;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function serializeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack ?? null,
      ...(hasCause(error) ? { error_cause: serializeErrorCause(error.cause) } : {}),
    };
  }
  return {
    error_name: typeof error,
    error_message: String(error),
    error_stack: null,
  };
}

function serializeErrorCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      error_name: cause.name,
      error_message: cause.message,
      error_stack: cause.stack ?? null,
      ...(hasCause(cause) ? { error_cause: serializeErrorCause(cause.cause) } : {}),
    };
  }
  if (cause === null || cause === undefined || ["string", "number", "boolean"].includes(typeof cause)) {
    return cause;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function hasCause(error: Error): error is Error & { cause: unknown } {
  return "cause" in error;
}
