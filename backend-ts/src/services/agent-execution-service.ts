import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../contracts/agent-config.js";
import type {
  AgentRunStartResult,
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
import type { AgentSessionApplication } from "./agent-session-application.js";
import type { AgentRuntimeContextBuilder } from "./agent-runtime-context-builder.js";
import type { ConversationStore } from "./conversation-store.js";
import type { InMemoryEventBus } from "./event-bus.js";
import type { AgentRuntimeCore, AgentRuntimeEvent } from "./agent-runtime-core.js";
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
      this.events.publish(sessionId, {
        type: "session.updated",
        session_id: sessionId,
        ...(runningRunId ? { run_id: runningRunId } : {}),
        ...mirrorEventData({
          source: "running_session_followup",
          status: "running",
          run_id: runningRunId,
        }),
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
      type: "run.start",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(runStartPayload),
    });
    this.events.publish(sessionId, {
      type: "session.updated",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData({ source: "agent_stream", status: "running", run_id: runId }),
    });

    const promise = this.runMinimalAgent({
      sessionId,
      runId,
      taskId,
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
    requestId: string;
    task: string;
    startedAt: Date;
    abortController: AbortController;
    status: ExecutionTaskStatus;
    agent: AgentConfig;
    provider: ModelProviderConfig;
    modelName: string;
    userMessageId: string;
    conversationUpdateProvider?: (() => Promise<ChatMessage[]> | ChatMessage[]) | undefined;
  }): Promise<void> {
    try {
      const context = this.contextBuilder.buildContext({ sessionId: input.sessionId, agent: input.agent });
      const sessionMetadata = this.sessions.getSession(input.sessionId)?.metadata ?? {};
      const response = await this.agentRuntimeCore.runText({
        agent: input.agent,
        provider: input.provider,
        modelName: input.modelName,
        signal: input.abortController.signal,
        conversation: context.conversation,
        conversationUpdateProvider: input.conversationUpdateProvider,
        toolExecutor: this.runtimeTools ?? undefined,
        toolContext: this.runtimeTools
          ? buildRuntimeToolContext(input.agent, {
              sessionId: input.sessionId,
              runId: input.runId,
              taskId: input.taskId,
              requestId: input.requestId,
              sessionMetadata,
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
          execution_kind: "agent_stream",
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
        execution_kind: "agent_stream",
        execution_time: input.status.elapsed_seconds,
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
      this.events.publish(input.sessionId, {
        type: "session.updated",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({ source: "agent_stream", status: "completed", run_id: input.runId }),
      });
    } catch (error) {
      const interrupted = input.abortController.signal.aborted;
      const finalStatus = interrupted ? "interrupted" : "failed";
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addExecutionStep(input.sessionId, input.runId, {
        kind: "run",
        phase: finalStatus,
        agent_name: input.agent.agent_name,
        task_id: input.taskId,
        error: errorMessage,
      });
      this.conversationStore.updateRunStatus(input.runId, input.sessionId, finalStatus);
      this.finishStatus(input.status, finalStatus, input.startedAt);
      if (!interrupted) {
        this.events.publish(input.sessionId, {
          type: "agent.error",
          session_id: input.sessionId,
          run_id: input.runId,
          ...mirrorEventData({
            error: errorMessage,
            content: errorMessage,
            run_id: input.runId,
            task_id: input.taskId,
            request_id: input.requestId,
          }),
        });
      }
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
            execution_kind: "agent_stream",
            execution_time: input.status.elapsed_seconds,
          },
        }),
      });
      this.events.publish(input.sessionId, {
        type: "session.updated",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData({ source: "agent_stream", status: finalStatus, run_id: input.runId }),
      });
    } finally {
      this.taskBySession.delete(input.sessionId);
      this.handlesByTask.delete(input.taskId);
    }
  }

  private publishRuntimeEvent(
    input: {
      sessionId: string;
      runId: string;
      taskId: string;
      requestId: string;
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
      const payload = {
        kind: "tool",
        phase: "end",
        legacy_phase: "result",
        agent_name: event.data.agent_name,
        tool_name: event.data.tool_name,
        call_id: event.data.tool_call_id,
        tool_call_id: event.data.tool_call_id,
        status: event.data.success ? "success" : "error",
        success: event.data.success,
        summary: event.data.summary,
        result_preview: event.data.summary,
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
    teamName: asString(input.sessionMetadata.team),
    workspaceRoot: asString(input.sessionMetadata.workspace_root) ?? asString(agent.custom_params.workspace_root),
    signal: input.signal,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
