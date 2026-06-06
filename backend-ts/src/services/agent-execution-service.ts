import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../contracts/agent-config.js";
import type {
  AgentRunStartResult,
  CheckpointRecoveryStartResult,
  ExecutionDiagnostics,
  ExecutionOverview,
  ExecutionObservability,
  ExecutionTaskStatus,
  RunningTasksResult,
  ScopedExecutionDiagnostics,
  ScopedTaskStatus,
  SessionTaskStatus,
  StreamExecuteRequest,
} from "../contracts/execution.js";
import { getSelectedLlm as resolveSelectedLlm } from "../contracts/execution.js";
import type { ModelProviderConfig } from "../contracts/model-adapter.js";
import type { AgentContextCompressionService, ContextCompressionEvent } from "./agent-context-compression-service.js";
import type { AgentSessionApplication } from "./agent-session-application.js";
import type { AgentRuntimeContextBuilder } from "./agent-runtime-context-builder.js";
import type { CheckpointInfo } from "./checkpoint-manager.js";
import type { ConversationStore } from "./conversation-store.js";
import type { InMemoryEventBus } from "./event-bus.js";
import type { AgentRuntimeCore, AgentRuntimeEvent } from "./agent-runtime-core.js";
import {
  buildAgentPromptContext,
  buildFullSystemPrompt,
  type AgentPromptConfigResolver,
} from "./agent-prompt-builder.js";
import type { ChatMessage } from "./llm-chat-client.js";
import { renderSemanticBlock } from "./runtime-xml-protocol.js";
import type { RuntimeExecutionConfigResolver } from "./runtime-core-service.js";
import type { RuntimeToolExecutionContext, RuntimeToolExecutor } from "./runtime-tool-types.js";

interface ExecutionHandle {
  abortController: AbortController;
  status: ExecutionTaskStatus;
  promise: Promise<void>;
}

export class AgentExecutionService {
  private readonly handlesByTask = new Map<string, ExecutionHandle>();
  private readonly taskBySession = new Map<string, string>();
  private readonly statusHistory = new Map<string, ExecutionTaskStatus>();
  private readonly pendingFollowupsBySession = new Map<string, ChatMessage[]>();

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
  ) {}

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
    const runningStatus = this.getStatusBySession(sessionId);
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
      this.events.publish(sessionId, {
        type: "output.message_saved",
        session_id: sessionId,
        ...(runningRunId ? { run_id: runningRunId } : {}),
        ...mirrorEventData(followupPayload),
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
    const status: ExecutionTaskStatus = {
      task_id: taskId,
      session_id: sessionId,
      run_id: runId,
      request_id: requestId,
      execution_kind: "agent_stream",
      task,
      status: "running",
      elapsed_seconds: null,
      started_at: startedAt.toISOString(),
      finished_at: null,
      thread_alive: true,
    };

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
    const runStartPayload = {
      task_id: taskId,
      agent_name: runtimeAgent.agent_name,
      run_id: runId,
      request_id: requestId,
    };
    this.events.publish(sessionId, {
      type: "session.run_started",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(runStartPayload),
    });
    this.events.publish(sessionId, {
      type: "output.message_saved",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(userMessageSavedPayload),
    });

    const startStepPayload = {
      kind: "run",
      phase: "start",
      agent_name: runtimeAgent.agent_name,
      task_id: taskId,
      run_id: runId,
      request_id: requestId,
    };
    this.addExecutionStep(sessionId, runId, startStepPayload);
    this.events.publish(sessionId, {
      type: "execution.step",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(startStepPayload),
    });

    this.events.publish(sessionId, {
      type: "run.start",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(runStartPayload),
    });

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
    this.handlesByTask.set(taskId, { abortController, status, promise });
    this.taskBySession.set(sessionId, taskId);
    this.statusHistory.set(taskId, status);

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
    const taskId = this.taskBySession.get(sessionId);
    if (!taskId) {
      return false;
    }
    const handle = this.handlesByTask.get(taskId);
    if (!handle || handle.status.status !== "running") {
      return false;
    }
    this.publishUserInterrupt(handle.status, "user_stop");
    handle.abortController.abort();
    return true;
  }

  getSessionTaskStatus(sessionId: string): SessionTaskStatus {
    const status = this.getStatusBySession(sessionId);
    const diagnostics = status ? this.buildDiagnostics(status) : null;
    return {
      session_id: sessionId,
      has_running_task: status?.status === "running",
      has_active_system_command: false,
      task_info: status,
      observability: status ? buildObservability(status) : null,
      diagnostics,
    };
  }

  getSessionExecutionDiagnostics(sessionId: string): ScopedExecutionDiagnostics {
    const status = this.getStatusBySession(sessionId);
    return {
      session_id: sessionId,
      scope: "session_id",
      scope_id: sessionId,
      found: status !== null,
      diagnostics: status ? this.buildDiagnostics(status) : null,
    };
  }

  getTaskStatus(taskId: string): ScopedTaskStatus {
    const status = this.getStatus(taskId);
    return {
      task_id: taskId,
      scope: "task_id",
      scope_id: taskId,
      found: status !== null,
      has_running_task: status?.status === "running",
      task_info: status,
      observability: status ? buildObservability(status) : null,
    };
  }

  getTaskExecutionDiagnostics(taskId: string): ScopedExecutionDiagnostics {
    const status = this.getStatus(taskId);
    return {
      task_id: taskId,
      scope: "task_id",
      scope_id: taskId,
      found: status !== null,
      diagnostics: status ? this.buildDiagnostics(status) : null,
    };
  }

  listRunningTasks(): RunningTasksResult {
    const items = this.listStatuses(true);
    return {
      active_only: true,
      count: items.length,
      items,
    };
  }

  getOverview(activeOnly: boolean): ExecutionOverview {
    const items = this.listStatuses(activeOnly);
    const byExecutionKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const sessions: string[] = [];
    const seenSessions = new Set<string>();

    for (const item of items) {
      byExecutionKind[item.execution_kind] = (byExecutionKind[item.execution_kind] ?? 0) + 1;
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      if (item.session_id && !seenSessions.has(item.session_id)) {
        seenSessions.add(item.session_id);
        sessions.push(item.session_id);
      }
    }

    return {
      active_only: activeOnly,
      count: items.length,
      by_execution_kind: byExecutionKind,
      by_status: byStatus,
      sessions,
      items,
    };
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
    const runningStatus = this.getStatusBySession(sessionId);
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
    const status: ExecutionTaskStatus = {
      task_id: taskId,
      session_id: sessionId,
      run_id: runId,
      request_id: input.requestId,
      execution_kind: executionKind,
      task,
      status: "running",
      elapsed_seconds: null,
      started_at: startedAt.toISOString(),
      finished_at: null,
      thread_alive: true,
    };
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

    const startStepPayload = {
      kind: "run",
      phase: "start",
      agent_name: runtimeAgent.agent_name,
      task_id: taskId,
      run_id: runId,
      request_id: input.requestId,
      execution_kind: executionKind,
      recovered_from: input.checkpoint.checkpoint_id,
      checkpoint_id: input.checkpoint.checkpoint_id,
      checkpoint_round: input.checkpoint.round,
    };
    const runStartPayload = {
      task_id: taskId,
      agent_name: runtimeAgent.agent_name,
      run_id: runId,
      request_id: input.requestId,
      execution_kind: executionKind,
      recovered_from: input.checkpoint.checkpoint_id,
    };
    this.events.publish(sessionId, {
      type: "session.run_started",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(runStartPayload),
    });
    this.addExecutionStep(sessionId, runId, startStepPayload);
    this.events.publish(sessionId, {
      type: "execution.step",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(startStepPayload),
    });
    this.events.publish(sessionId, {
      type: "run.start",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(runStartPayload),
    });

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
    this.handlesByTask.set(taskId, { abortController, status, promise });
    this.taskBySession.set(sessionId, taskId);
    this.statusHistory.set(taskId, status);

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

  private getStatus(taskId: string): ExecutionTaskStatus | null {
    return cloneStatus(this.statusHistory.get(taskId) ?? null);
  }

  private getStatusBySession(sessionId: string): ExecutionTaskStatus | null {
    const runningTaskId = this.taskBySession.get(sessionId);
    if (runningTaskId) {
      return this.getStatus(runningTaskId);
    }
    const latest = Array.from(this.statusHistory.values())
      .filter((status) => status.session_id === sessionId)
      .sort((left, right) => String(right.started_at ?? "").localeCompare(String(left.started_at ?? "")))[0];
    return cloneStatus(latest ?? null);
  }

  private listStatuses(activeOnly: boolean): ExecutionTaskStatus[] {
    return Array.from(this.statusHistory.values())
      .filter((status) => !activeOnly || status.status === "running")
      .map((status) => ({ ...status }))
      .sort((left, right) => String(right.started_at ?? "").localeCompare(String(left.started_at ?? "")));
  }

  private buildDiagnostics(status: ExecutionTaskStatus): ExecutionDiagnostics {
    return {
      task: status,
      runner: null,
      observability: buildObservability(status),
      handle_registered: false,
      is_running: status.status === "running",
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
      this.publishRootAgentStart({
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
              onEvent: (event) => this.publishContextCompressionEvent(input, event),
            });
      const context = input.contextConversation
        ? { conversation: input.contextConversation }
        : this.contextBuilder.buildContext({ sessionId: input.sessionId, agent: input.agent });
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
      this.events.publish(input.sessionId, {
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
        conversationUpdateProvider: input.conversationUpdateProvider,
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
          this.publishRuntimeEvent(input, event);
        },
      });
      const assistantMessage = this.sessions.addMessage({
        sessionId: input.sessionId,
        role: "assistant",
        content: response.content,
        metadata: {
          agent: input.agent.agent_name,
          run_id: input.runId,
          request_id: input.requestId,
          msg_type: "assistant_final",
          execution_kind: executionKind,
          ...(input.finalMetadataExtra ?? {}),
        },
      });
      this.addExecutionStep(input.sessionId, input.runId, {
        kind: "final",
        phase: "complete",
        agent_name: input.agent.agent_name,
        task_id: input.taskId,
        result_preview: response.content.slice(0, 500),
      });
      this.conversationStore.updateRunStepsMessageId(input.sessionId, input.runId, assistantMessage.id);
      this.conversationStore.updateRunStatus(input.runId, input.sessionId, "completed", assistantMessage.id);
      this.finishStatus(input.status, "completed", input.startedAt);
      const finalMetadata = {
        agent: input.agent.agent_name,
        run_id: input.runId,
        request_id: input.requestId,
        execution_kind: executionKind,
        execution_time: input.status.elapsed_seconds,
        ...(input.finalMetadataExtra ?? {}),
      };
      const finalStepPayload = {
        kind: "final",
        phase: "complete",
        message_id: assistantMessage.id,
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      };
      this.events.publish(input.sessionId, {
        type: "execution.step",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData(finalStepPayload),
      });
      this.events.publish(input.sessionId, {
        type: "output.final_answer",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({
          content: response.content,
          metadata: finalMetadata,
        }),
      });
      this.publishRootAgentEnd({
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        rootCallId: input.rootCallId,
        agent: input.agent,
        result: response.content,
        success: true,
      });
      this.events.publish(input.sessionId, {
        type: "output.message_saved",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({
          id: assistantMessage.id,
          seq: assistantMessage.seq,
          role: assistantMessage.role,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
        }),
      });
      this.events.publish(input.sessionId, {
        type: "run.end",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({
          status: "completed",
          final_message_id: assistantMessage.id,
          metadata: finalMetadata,
        }),
      });
    } catch (error) {
      const interrupted = input.abortController.signal.aborted;
      const finalStatus = interrupted ? "interrupted" : "failed";
      const errorMessage = error instanceof Error ? error.message : String(error);
      const executionKind = input.executionKind ?? "agent_stream";
      this.addExecutionStep(input.sessionId, input.runId, {
        kind: "run",
        phase: finalStatus,
        agent_name: input.agent.agent_name,
        task_id: input.taskId,
        error: errorMessage,
      });
      this.conversationStore.updateRunStatus(input.runId, input.sessionId, finalStatus);
      this.finishStatus(input.status, finalStatus, input.startedAt);
      this.publishRootAgentEnd({
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        rootCallId: input.rootCallId,
        agent: input.agent,
        result: interrupted ? "[已停止生成]" : errorMessage,
        success: false,
      });
      this.events.publish(input.sessionId, {
        type: "agent.error",
        session_id: input.sessionId,
        run_id: input.runId,
        agent_name: input.agent.agent_name,
        call_id: input.rootCallId,
        ...mirrorEventData({
          agent_name: input.agent.agent_name,
          error: errorMessage,
          error_type: interrupted ? "InterruptedError" : "ExecutionError",
          content: errorMessage,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
        }),
      });
      this.events.publish(input.sessionId, {
        type: "run.end",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({
          status: finalStatus,
          error: errorMessage,
          metadata: {
            agent: input.agent.agent_name,
            run_id: input.runId,
            request_id: input.requestId,
            execution_kind: executionKind,
            execution_time: input.status.elapsed_seconds,
            ...(input.finalMetadataExtra ?? {}),
          },
        }),
      });
    } finally {
      this.taskBySession.delete(input.sessionId);
      this.handlesByTask.delete(input.taskId);
    }
  }

  private publishRootAgentStart(input: {
    sessionId: string;
    runId: string;
    taskId: string;
    requestId: string;
    rootCallId: string;
    agent: AgentConfig;
    task: string;
  }): void {
    const agentName = input.agent.agent_name;
    const displayName = input.agent.display_name || agentName;
    this.events.publish(input.sessionId, {
      type: "agent.start",
      session_id: input.sessionId,
      run_id: input.runId,
      agent_name: agentName,
      call_id: input.rootCallId,
      ...mirrorEventData({
        agent_name: agentName,
        task: input.task,
        description: input.task,
        metadata: {},
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      }),
    });
    this.events.publish(input.sessionId, {
      type: "call.agent.start",
      session_id: input.sessionId,
      run_id: input.runId,
      agent_name: agentName,
      call_id: input.rootCallId,
      ...mirrorEventData({
        agent_name: agentName,
        description: input.task,
        agent_display_name: displayName,
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      }),
    });
  }

  private publishRootAgentEnd(input: {
    sessionId: string;
    runId: string;
    taskId: string;
    requestId: string;
    rootCallId: string;
    agent: AgentConfig;
    result: string;
    success: boolean;
  }): void {
    const agentName = input.agent.agent_name;
    const displayName = input.agent.display_name || agentName;
    this.events.publish(input.sessionId, {
      type: "call.agent.end",
      session_id: input.sessionId,
      run_id: input.runId,
      agent_name: agentName,
      call_id: input.rootCallId,
      ...mirrorEventData({
        agent_name: agentName,
        result: input.result.slice(0, 500),
        success: input.success,
        agent_display_name: displayName,
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      }),
    });
  }

  private publishUserInterrupt(status: ExecutionTaskStatus, reason: string): void {
    const sessionId = status.session_id;
    if (!sessionId) {
      return;
    }
    const payload = {
      reason,
      task_id: status.task_id,
      session_id: sessionId,
      run_id: status.run_id,
      execution_kind: status.execution_kind,
      request_id: status.request_id,
    };
    this.events.publish(sessionId, {
      type: "user.interrupt",
      session_id: sessionId,
      ...(status.run_id ? { run_id: status.run_id } : {}),
      ...mirrorEventData(payload),
    });
  }

  private publishContextCompressionEvent(
    input: {
      sessionId: string;
      runId: string;
      taskId: string;
      requestId: string;
      agent: AgentConfig;
    },
    event: ContextCompressionEvent,
  ): void {
    const payload = {
      ...event.data,
      run_id: input.runId,
      task_id: input.taskId,
      request_id: input.requestId,
      agent_name: input.agent.agent_name,
    };
    if (event.type === "context.compression_start") {
      this.addExecutionStep(input.sessionId, input.runId, {
        kind: "context",
        phase: "compression_start",
        ...payload,
      });
    } else if (event.type === "context.compression_summary") {
      this.addExecutionStep(input.sessionId, input.runId, {
        kind: "context",
        phase: "compression_summary",
        ...payload,
      });
    }
    this.events.publish(input.sessionId, {
      type: event.type,
      session_id: input.sessionId,
      run_id: input.runId,
      agent_name: input.agent.agent_name,
      ...mirrorEventData(payload),
    });
  }

  private publishRuntimeEvent(
    input: {
      sessionId: string;
      runId: string;
      taskId: string;
      requestId: string;
      rootCallId: string;
    },
    event: AgentRuntimeEvent,
  ): void {
    if (event.type === "runtime.first_token") {
      this.events.publish(input.sessionId, {
        type: "llm.first_token",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({
          elapsed_ms: event.data.elapsed_ms,
          agent_name: event.data.agent_name,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
        }),
      });
      return;
    }
    if (event.type === "runtime.output_delta") {
      this.events.publish(input.sessionId, {
        type: "output.chunk",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({
          content: event.data.content,
          agent_name: event.data.agent_name,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
        }),
      });
      return;
    }
    if (event.type === "runtime.intent_delta") {
      this.events.publish(input.sessionId, {
        type: "agent.intent_delta",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({
          content: event.data.content,
          agent_name: event.data.agent_name,
          round: event.data.round,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
        }),
      });
      return;
    }
    if (event.type === "runtime.intent_complete") {
      this.events.publish(input.sessionId, {
        type: "agent.intent_complete",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({
          content: event.data.content,
          agent_name: event.data.agent_name,
          round: event.data.round,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
        }),
      });
      return;
    }
    if (event.type === "runtime.tool_call") {
      const payload = {
        kind: "tool",
        phase: "start",
        legacy_phase: "call",
        agent_name: event.data.agent_name,
        tool_name: event.data.tool_name,
        call_id: event.data.tool_call_id,
        tool_call_id: event.data.tool_call_id,
        parent_call_id: input.rootCallId,
        arguments: event.data.arguments,
        round: event.data.round,
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      };
      this.addExecutionStep(input.sessionId, input.runId, payload);
      this.events.publish(input.sessionId, {
        type: "execution.step",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData(payload),
      });
      return;
    }
    if (event.type === "runtime.tool_result") {
      const approvalMessage = asString(event.data.metadata.approval_message);
      const approvalMetadata = isRecord(event.data.metadata.approval) ? event.data.metadata.approval : null;
      const payload = {
        kind: "tool",
        phase: "end",
        legacy_phase: "result",
        agent_name: event.data.agent_name,
        tool_name: event.data.tool_name,
        call_id: event.data.tool_call_id,
        tool_call_id: event.data.tool_call_id,
        parent_call_id: input.rootCallId,
        status: event.data.success ? "success" : "error",
        success: event.data.success,
        summary: event.data.summary,
        result_preview: event.data.summary,
        ...(approvalMessage ? { approval_message: approvalMessage } : {}),
        ...(approvalMetadata ? { approval: approvalMetadata } : {}),
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      };
      this.addExecutionStep(input.sessionId, input.runId, payload);
      this.events.publish(input.sessionId, {
        type: "execution.step",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData(payload),
      });
    }
  }

  private addExecutionStep(sessionId: string, runId: string, payload: Record<string, unknown>): void {
    this.conversationStore.addRunStep({
      sessionId,
      runId,
      stepType: "execution.step",
      payload,
    });
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

  private finishStatus(status: ExecutionTaskStatus, finalStatus: string, startedAt: Date): void {
    const finishedAt = new Date();
    status.status = finalStatus;
    status.finished_at = finishedAt.toISOString();
    status.elapsed_seconds = (finishedAt.getTime() - startedAt.getTime()) / 1000;
    status.thread_alive = false;
  }

  private resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig): number {
    return this.contextCompression?.resolveContextBudget(agent, provider) ?? resolveLegacyContextBudget(agent, provider);
  }
}

function buildObservability(status: ExecutionTaskStatus): ExecutionObservability {
  return {
    task_id: status.task_id,
    session_id: status.session_id,
    run_id: status.run_id,
    execution_kind: status.execution_kind,
    request_id: status.request_id,
  };
}

function summarizeReadinessFailure(requirements: Array<{ category: string; satisfied: boolean; message: string }>): string {
  const failures = requirements.filter((item) => item.category !== "execution_runtime" && !item.satisfied);
  return failures.length ? failures.map((item) => item.message).join("; ") : "Runtime core configuration is not ready";
}

function mirrorEventData<T extends Record<string, unknown>>(data: T): { data: T; content: T } {
  return {
    data,
    content: data,
  };
}

function cloneStatus(status: ExecutionTaskStatus | null): ExecutionTaskStatus | null {
  return status ? { ...status } : null;
}

function findLatestCheckpointUserTask(checkpoint: CheckpointInfo): string | null {
  for (let index = checkpoint.messages.length - 1; index >= 0; index -= 1) {
    const message = checkpoint.messages[index];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }
  }
  return null;
}

function checkpointMessagesToConversation(messages: Array<Record<string, unknown>>): ChatMessage[] {
  const conversation: ChatMessage[] = [];
  for (const message of messages) {
    const role = message.role;
    const content = message.content;
    if (typeof content !== "string" || !content.trim()) {
      continue;
    }
    if (role === "system" || role === "user" || role === "assistant") {
      conversation.push({ role, content });
    }
  }
  return conversation;
}

function normalizeSessionEntryAgent(value: unknown): string | null {
  const normalized = asString(value);
  if (!normalized) {
    return null;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === "default") {
    return null;
  }
  if (lowered === "orchestrator") {
    return "orchestrator_agent";
  }
  return normalized;
}

function applySessionAgentOverrides(agent: AgentConfig, sessionMetadata: Record<string, unknown>): AgentConfig {
  const workspaceRoot = asString(sessionMetadata.workspace_root);
  if (!workspaceRoot) {
    return agent;
  }
  return {
    ...agent,
    custom_params: {
      ...agent.custom_params,
      workspace_root: workspaceRoot,
    },
  };
}

function buildRuntimeToolContext(
  agent: AgentConfig,
  input: {
    sessionId: string;
    runId: string;
    taskId: string;
    requestId: string;
    sessionMetadata: Record<string, unknown>;
    parentCallId?: string | null | undefined;
    signal: AbortSignal;
  },
): RuntimeToolExecutionContext {
  return {
    agent,
    sessionId: input.sessionId,
    runId: input.runId,
    taskId: input.taskId,
    requestId: input.requestId,
    currentAgentName: agent.agent_name,
    parentCallId: input.parentCallId ?? null,
    teamName: asString(input.sessionMetadata.team),
    workspaceRoot: asString(input.sessionMetadata.workspace_root) ?? asString(agent.custom_params.workspace_root),
    signal: input.signal,
  };
}

function buildContextUsagePayload(input: {
  agent: AgentConfig;
  promptContext: ReturnType<typeof buildAgentPromptContext>;
  budgetTokens: number;
  messages: ChatMessage[];
  round: number;
  runId: string;
  taskId: string;
  requestId: string;
  compressionResult?: {
    status: string;
    reason: string;
    replacedMessageCount: number;
    replacesUpToSeq: number | null;
  } | null;
}): Record<string, unknown> {
  const rawSystemPromptTokens = estimateTokens(buildFullSystemPrompt(input.agent, input.promptContext));
  const systemContextTokens = input.messages
    .filter((message) => message.role === "system")
    .reduce((total, message) => total + estimateTokens(message.content), 0);
  const historyTokens = input.messages
    .filter((message) => message.role !== "system")
    .reduce((total, message) => total + estimateTokens(message.content), 0);
  const systemPromptTokens = rawSystemPromptTokens + systemContextTokens;
  const totalTokens = systemPromptTokens + historyTokens;
  return {
    used_tokens: totalTokens,
    system_prompt_tokens: systemPromptTokens,
    total_tokens: totalTokens,
    budget_tokens: input.budgetTokens,
    round: input.round,
    compressing: false,
    agent_name: input.agent.agent_name,
    run_id: input.runId,
    task_id: input.taskId,
    request_id: input.requestId,
    ...(input.compressionResult
      ? {
          compression: {
            status: input.compressionResult.status,
            reason: input.compressionResult.reason,
            replaced_message_count: input.compressionResult.replacedMessageCount,
            replaces_up_to_seq: input.compressionResult.replacesUpToSeq,
          },
        }
      : {}),
  };
}

function resolveLegacyContextBudget(agent: AgentConfig, provider: ModelProviderConfig): number {
  return positiveInt(provider.max_context_tokens)
    ?? positiveInt(agent.llm_tiers?.default?.max_context_tokens)
    ?? 128000;
}

function estimateTokens(content: string): number {
  if (!content) {
    return 0;
  }
  const cjkChars = content.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const nonCjk = content.length - cjkChars;
  return Math.max(1, cjkChars + Math.ceil(nonCjk / 4));
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
