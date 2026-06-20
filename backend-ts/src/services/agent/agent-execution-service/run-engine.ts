import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { AgentExecuteResult, AgentRunStartResult, ExecutionTaskStatus } from "../../../contracts/execution.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { AgentContextCompressionService } from "../agent-context-compression-service.js";
import { buildAgentPromptContext, type AgentPromptConfigResolver } from "../agent-prompt-builder/index.js";
import type { AgentRuntimeContextBuilder } from "../agent-runtime-context-builder/index.js";
import type { KernelSession, MessageRefresher } from "../kernel/contracts.js";
import { DefaultHookRegistry } from "../kernel/hook-registry.js";
import { refreshStablePrefixCache } from "../kernel/stable-prefix.js";
import { RuntimeEventSink } from "../kernel-plugins/events/runtime-event-sink.js";
import { createRuntimeKernel } from "../kernel-plugins/create-runtime-kernel.js";
import type { AgentSessionApplication } from "../agent-session-application.js";
import type { ChatMessage, LlmChatClient } from "../../integrations/llm-chat-client.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import type { DurableClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { OutboxDispatcher } from "../../runtime/event-outbox/dispatcher.js";
import type { RuntimeToolExecutor } from "../../runtime/runtime-tool-types.js";
import type { IMessageStore, IRunStore, ISessionStore } from "../../../contracts/conversation-store/index.js";
import { AgentExecutionEventPublisher } from "./event-publisher.js";
import {
  asString,
  buildContextUsagePayload,
  buildFinalStepPayload,
  buildRunEndStepPayload,
  buildRunStartPayload,
  buildRunStartStepPayload,
  buildRuntimeToolContext,
  buildRunningExecutionStatus,
  mirrorEventData,
  renderBackgroundNotification,
  resolveLegacyContextBudget,
} from "./helpers.js";
import { ExecutionRecorder, type RunTerminalRecord } from "./recorder.js";
import { AgentExecutionStatusTracker } from "./status-tracker.js";

export interface AgentExecutionLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

/**
 * 一次 agent run 的完整生命周期引擎：生成 runId/taskId → createRun → 持久化 user message →
 * 发 start events → 执行（compress→buildContext→runText→recordTerminal）→ register status。
 * 合并原 startAgentRun + runMinimalAgent + buildSynchronousResult + drain 系列与 refreshStablePrefixCache。
 */
export class AgentRunEngine {
  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly conversationStore: IRunStore & IMessageStore & ISessionStore,
    private readonly llmChatClient: LlmChatClient,
    private readonly dataRoot: string,
    private readonly contextBuilder: AgentRuntimeContextBuilder,
    private readonly runtimeTools: RuntimeToolExecutor | null,
    private readonly contextCompression: AgentContextCompressionService | null,
    private readonly promptConfigResolver: AgentPromptConfigResolver | null,
    private readonly backgroundTasks: BackgroundTaskService | null,
    private readonly statusTracker: AgentExecutionStatusTracker,
    private readonly eventPublisher: AgentExecutionEventPublisher,
    private readonly executionRecorder: ExecutionRecorder,
    private readonly outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">,
    private readonly clientEvents: DurableClientEventPublisher,
    private readonly logger: AgentExecutionLogger | null,
  ) {}

  startRun(input: {
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
    stablePrefixFingerprint?: string | null | undefined;
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

    const promise = this.executeRun({
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
      stablePrefixFingerprint: input.stablePrefixFingerprint,
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

  buildSynchronousResult(input: {
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

  async executeRun(input: {
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
    stablePrefixFingerprint?: string | null | undefined;
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
      let stablePrefixFingerprint = input.stablePrefixFingerprint ?? null;
      const builtContext = input.contextConversation
        ? null
        : this.contextBuilder.buildContext({
            sessionId: input.sessionId,
            agent: input.agent,
            microcompact: true,
            forceMemoryPrefixRefresh: compressionResult?.status === "success" || compressionResult?.status === "fallback",
          });
      const context = builtContext ?? { conversation: [...input.contextConversation!, ...pendingBackgroundNotifications] };
      if (builtContext) {
        stablePrefixFingerprint = builtContext.metadata.stable_prefix_fingerprint;
      }
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
        provider: input.provider,
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
      const eventSink = new RuntimeEventSink((event) => {
        this.eventPublisher.publishRuntimeEvent(input, event);
      });
      const refresher: MessageRefresher = {
        refresh: async () =>
          this.drainConversationUpdates(input.sessionId, input.conversationUpdateProvider),
      };
      const hooks = new DefaultHookRegistry();
      hooks.register("afterModel", () => {
        refreshStablePrefixCache(
          this.conversationStore,
          input.sessionId,
          "root",
          stablePrefixFingerprint,
          this.logger ?? undefined,
        );
      });
      const kernel = createRuntimeKernel({
        llmChatClient: this.llmChatClient,
        provider: input.provider,
        dataRoot: this.dataRoot,
        eventSink,
        refresher,
        hooks,
      });
      const response = await kernel.run({
        agent: input.agent,
        provider: input.provider,
        modelName: input.modelName,
        conversation: context.conversation,
        promptContext,
        toolExecutor: this.runtimeTools ?? undefined,
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
        signal: input.abortController.signal,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        requestId: input.requestId,
        rootCallId: input.rootCallId,
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
