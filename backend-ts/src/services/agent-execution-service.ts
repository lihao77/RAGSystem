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
import type { AgentSessionApplication } from "./agent-session-application.js";
import type { ConversationStore } from "./conversation-store.js";
import type { InMemoryEventBus } from "./event-bus.js";
import type { LlmChatClient, ChatMessage } from "./llm-chat-client.js";
import type { RuntimeCoreService } from "./runtime-core-service.js";

interface ExecutionHandle {
  abortController: AbortController;
  status: ExecutionTaskStatus;
  promise: Promise<void>;
}

export class AgentExecutionService {
  private readonly handlesByTask = new Map<string, ExecutionHandle>();
  private readonly taskBySession = new Map<string, string>();
  private readonly statusHistory = new Map<string, ExecutionTaskStatus>();

  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly events: InMemoryEventBus,
    private readonly conversationStore: ConversationStore,
    private readonly runtimeCore: RuntimeCoreService,
    private readonly llmChatClient: LlmChatClient,
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
    if (this.getStatusBySession(sessionId)?.status === "running") {
      return {
        started: false,
        session_id: sessionId,
        error: "该会话正在执行任务，请等待完成或停止当前任务",
      };
    }

    const resolved = this.runtimeCore.resolveExecutionConfig({
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
    this.conversationStore.createRun({
      runId,
      sessionId,
      entrypoint: "agent_stream",
      status: "running",
      taskSummary: task.slice(0, 200),
      userId: request.user_id ?? null,
      agentName: resolved.agent.agent_name,
      threadKey: "root",
    });
    const userMessage = this.sessions.addMessage({
      sessionId,
      role: "user",
      content: task,
      metadata: {
        agent: resolved.agent.agent_name,
        run_id: runId,
        request_id: requestId,
        execution_kind: "agent_stream",
      },
    });
    this.addExecutionStep(sessionId, runId, {
      kind: "run",
      phase: "start",
      agent_name: resolved.agent.agent_name,
      task_id: taskId,
    });
    this.events.publish(sessionId, {
      type: "run.start",
      session_id: sessionId,
      run_id: runId,
      content: {
        task_id: taskId,
        agent_name: resolved.agent.agent_name,
      },
    });
    this.events.publish(sessionId, {
      type: "session.updated",
      session_id: sessionId,
      run_id: runId,
      content: { source: "agent_stream", status: "running" },
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
      agent: resolved.agent,
      provider: resolved.provider,
      modelName: resolved.modelName,
      userMessageId: userMessage.id,
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
    provider: Parameters<LlmChatClient["complete"]>[0]["provider"];
    modelName: string;
    userMessageId: string;
  }): Promise<void> {
    try {
      const response = await this.llmChatClient.complete({
        messages: this.buildChatMessages(input.sessionId, input.agent),
        model: input.modelName,
        provider: input.provider,
        agent: input.agent,
        signal: input.abortController.signal,
        temperature: input.agent.llm_tiers?.default?.temperature ?? null,
        maxCompletionTokens: input.agent.llm_tiers?.default?.max_completion_tokens ?? null,
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
      this.events.publish(input.sessionId, {
        type: "execution.step",
        session_id: input.sessionId,
        run_id: input.runId,
        content: {
          kind: "final",
          phase: "complete",
          message_id: assistantMessage.id,
        },
      });
      this.events.publish(input.sessionId, {
        type: "run.end",
        session_id: input.sessionId,
        run_id: input.runId,
        content: {
          status: "completed",
          final_message_id: assistantMessage.id,
        },
      });
      this.events.publish(input.sessionId, {
        type: "session.updated",
        session_id: input.sessionId,
        run_id: input.runId,
        content: { source: "agent_stream", status: "completed" },
      });
    } catch (error) {
      const interrupted = input.abortController.signal.aborted;
      const finalStatus = interrupted ? "interrupted" : "failed";
      this.addExecutionStep(input.sessionId, input.runId, {
        kind: "run",
        phase: finalStatus,
        agent_name: input.agent.agent_name,
        task_id: input.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.conversationStore.updateRunStatus(input.runId, input.sessionId, finalStatus);
      this.finishStatus(input.status, finalStatus, input.startedAt);
      this.events.publish(input.sessionId, {
        type: "run.end",
        session_id: input.sessionId,
        run_id: input.runId,
        content: {
          status: finalStatus,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      this.events.publish(input.sessionId, {
        type: "session.updated",
        session_id: input.sessionId,
        run_id: input.runId,
        content: { source: "agent_stream", status: finalStatus },
      });
    } finally {
      this.taskBySession.delete(input.sessionId);
      this.handlesByTask.delete(input.taskId);
    }
  }

  private buildChatMessages(sessionId: string, agent: AgentConfig): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const systemPrompt = getSystemPrompt(agent);
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    for (const message of this.conversationStore.getRecentMessages(sessionId, 20, "root")) {
      if (message.role === "user" || message.role === "assistant") {
        messages.push({ role: message.role, content: message.content });
      }
    }
    return messages;
  }

  private addExecutionStep(sessionId: string, runId: string, payload: Record<string, unknown>): void {
    this.conversationStore.addRunStep({
      sessionId,
      runId,
      stepType: "execution.step",
      payload,
    });
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

function getSystemPrompt(agent: AgentConfig): string | null {
  const behavior = agent.custom_params.behavior;
  if (!isRecord(behavior)) {
    return null;
  }
  return typeof behavior.system_prompt === "string" && behavior.system_prompt.trim() ? behavior.system_prompt.trim() : null;
}

function cloneStatus(status: ExecutionTaskStatus | null): ExecutionTaskStatus | null {
  return status ? { ...status } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
