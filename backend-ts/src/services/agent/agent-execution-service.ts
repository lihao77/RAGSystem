import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../../contracts/agent-config.js";
import type {
  AgentRunStartResult,
  CheckpointRecoveryStartResult,
  ExecutionOverview,
  ExecutionTaskStatus,
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
import type { CheckpointInfo } from "../stores/checkpoint-manager.js";
import type { ConversationStore } from "../stores/conversation-store.js";
import type { InMemoryEventBus } from "../runtime/event-bus.js";
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
}

export class AgentExecutionService {
  private readonly statusTracker = new AgentExecutionStatusTracker();
  private readonly pendingFollowupsBySession = new Map<string, ChatMessage[]>();
  private readonly eventPublisher: AgentExecutionEventPublisher;
  private readonly executionRecorder: ExecutionRecorder;
  private readonly outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">;
  private readonly clientEvents: DurableClientEventPublisher;

  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly events: InMemoryEventBus,
    private readonly conversationStore: ConversationStore,
    private readonly runtimeCore: RuntimeExecutionConfigResolver,
    private readonly agentRuntimeCore: AgentRuntimeCore,
    private readonly contextBuilder: AgentRuntimeContextBuilder,
    private readonly runtimeTools: RuntimeToolExecutor | null = null,
    private readonly contextCompression: AgentContextCompressionService | null = null,
    private readonly promptConfigResolver: AgentPromptConfigResolver | null = null,
    private readonly backgroundTasks: BackgroundTaskService | null = null,
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
  }

  async startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult> {
    const sessionId = request.session_id?.trim() || randomUUID();
    const task = request.task.trim();
    if (!task && request.attachments.length === 0) {
      return {
        started: false,
        session_id: sessionId,
        error: "Task and attachments cannot both be empty",
      };
    }
    if (request.attachments.length > 0) {
      return {
        started: false,
        session_id: sessionId,
        error: "Attachments are not supported by the minimal TypeScript runtime core yet",
      };
    }
    if (task.startsWith("/")) {
      return {
        started: false,
        session_id: sessionId,
        error: "Slash commands are not supported by the minimal TypeScript runtime core yet",
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
}
