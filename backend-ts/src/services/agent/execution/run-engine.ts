import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { AgentExecuteResult, AgentRunStartResult, ExecutionTaskStatus } from "../../../contracts/execution.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { AgentContextService } from "../context/index.js";
import type { AgentPromptConfigResolver } from "../prompt-builder/index.js";
import type { AgentSessionApplication } from "../../sessions/index.js";
import type { ChatMessage, LlmChatClient } from "../../integrations/llm-chat-client.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import { executeRunWithSdk } from "../sdk/runtime-adapter.js";
import type { DurableClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { OutboxDispatcher } from "../../runtime/event-outbox/dispatcher.js";
import type { RuntimeToolExecutor } from "../../runtime/runtime-tool-types.js";
import type { IMessageStore, IRunStore, ISessionStore } from "../../../contracts/conversation-store/index.js";
import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import { AgentExecutionEventPublisher } from "./event-publisher.js";
import {
  asString,
  buildFinalStepPayload,
  buildRunEndStepPayload,
  buildToolContext,
  buildRunningExecutionStatus,
  renderBackgroundNotification,
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
    private readonly contextService: AgentContextService,
   private readonly runtimeTools: RuntimeToolExecutor | null,
   private readonly promptConfigResolver: AgentPromptConfigResolver | null,
   /** 已加载的 provider 列表提供者（投影层解析 tier.provider 引用用）。 */
   private readonly providersProvider: () => ModelProviderConfig[],
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
  }): AgentRunStartResult & { promise: Promise<{ content: string; success: boolean }> } {
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

    this.eventPublisher.publishRunStarted(input.sessionId, runId, {
      request_id: input.requestId,
      task: input.task,
    });
    if (userMessageSavedPayload) {
      this.eventPublisher.publishOutputMessageSaved(input.sessionId, runId, {
        message_id: typeof userMessageSavedPayload.id === "string" ? userMessageSavedPayload.id : "",
        ...(typeof userMessageSavedPayload.seq === "number" ? { seq: userMessageSavedPayload.seq } : {}),
        ...(typeof userMessageSavedPayload.role === "string" ? { role: userMessageSavedPayload.role } : {}),
        ...(input.requestId ? { request_id: input.requestId } : {}),
      });
    }
    this.eventPublisher.publishRootAgentStart({
      sessionId: input.sessionId,
      runId,
      taskId,
      requestId: input.requestId,
      rootCallId,
      parentCallId: null,
      agent: input.agent,
      task: input.task,
      threadKey: "root",
    });

    const promise = this.executeRun({
      sessionId: input.sessionId,
      runId,
      taskId,
      rootCallId,
      requestId: input.requestId,
      task: input.task,
      startedAt,
      abortController,
      agent: input.agent,
      provider: input.provider,
      modelName: input.modelName,
      threadKey: "root",
      parentRunId: null,
      childAgentId: null,
      userMessageId: existingUserMessageId,
      conversationUpdateProvider: input.conversationUpdateProvider,
      executionKind: input.executionKind,
      contextConversation: input.contextConversation,
      stablePrefixFingerprint: input.stablePrefixFingerprint,
      finalMetadataExtra: input.finalMetadataExtra,
      onTerminal: (finalStatus) => this.statusTracker.finishStatus(status, finalStatus, startedAt),
    });
    this.statusTracker.register(taskId, input.sessionId, { abortController, status, promise });
    promise.finally(() => this.statusTracker.unregister(taskId, input.sessionId));

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
    agent: AgentConfig;
    provider: ModelProviderConfig;
    modelName: string;
    // run 自己的归属：root run threadKey="root"、parent=null；child run threadKey="child:<id>"、
    // parent_run_id/child_agent_id 指向父。执行链路据此统一落库，无 root/child 分支。
    threadKey: string;
    parentRunId?: string | null;
    parentCallId?: string | null | undefined;
    childAgentId?: string | null;
    userMessageId?: string | undefined;
    conversationUpdateProvider?: (() => Promise<ChatMessage[]> | ChatMessage[]) | undefined;
    executionKind?: string | undefined;
    contextConversation?: ChatMessage[] | undefined;
    stablePrefixFingerprint?: string | null | undefined;
    finalMetadataExtra?: Record<string, unknown> | undefined;
    // 终态回调（替代直接耦合 statusTracker）：root 由 startRun 壳传绑定 statusTracker 的回调，
    // child 不传。executeRun 自己用 startedAt 算 execution_time，不依赖外部 status 对象。
    onTerminal?: (finalStatus: "completed" | "failed" | "interrupted") => void;
  }): Promise<{ content: string; success: boolean }> {
    try {
      const sessionMetadata = this.sessions.getSession(input.sessionId)?.metadata ?? {};
      const executionKind = input.executionKind ?? "agent_stream";
      const pendingBackgroundNotifications = this.drainBackgroundTaskNotifications(input.sessionId);

      // 构建对话：优先用调用方传入的 contextConversation，否则从 store 历史 + 当前 user 消息组装。
      const conversation: ChatMessage[] = input.contextConversation
        ? [...input.contextConversation, ...pendingBackgroundNotifications]
        : [
            ...this.conversationStore.getRecentMessages(input.sessionId, undefined, input.threadKey).map(toStructuredChatMessage),
            { role: "user" as const, content: input.task },
            ...pendingBackgroundNotifications,
          ];

      const result = await executeRunWithSdk(
       {
          // run-engine 的 conversationStore 实际是完整 ConversationStore（构造时传入窄类型）。
          conversationStore: this.conversationStore as unknown as ConversationStore,
          // 无工具桥时用空工具执行器（SDK 内核照常跑，仅无工具可调）。
          runtimeToolBridge: this.runtimeTools ?? emptyToolExecutor,
          llmChatClient: this.llmChatClient,
          eventPublisher: this.eventPublisher,
          clientEvents: this.clientEvents,
          providers: this.providersProvider(),
          dataRoot: this.dataRoot,
        },
        {
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: input.taskId,
          requestId: input.requestId,
          rootCallId: input.rootCallId,
          agent: input.agent,
          provider: input.provider,
          modelName: input.modelName,
          task: input.task,
          threadKey: input.threadKey,
          ...(input.parentCallId !== undefined && input.parentCallId !== null ? { parentCallId: input.parentCallId } : {}),
         ...(input.childAgentId !== undefined ? { childAgentId: input.childAgentId } : {}),
          // backend-ts ChatMessage 与 agent-llm ChatMessage 结构同构（exactOptionalPropertyTypes 差异），边界强转。
          conversation: conversation as unknown as import("@ragsystem/agent-llm").ChatMessage[],
         sessionMetadata,
         ...(input.executionKind !== undefined ? { executionKind } : {}),
          ...(asString(sessionMetadata.user_id) ? { userId: asString(sessionMetadata.user_id) } : {}),
         signal: input.abortController.signal,
          selectedLlm: { provider: input.provider, modelName: input.modelName },
        },
      );

      if (!result.success) {
        const interrupted = input.abortController.signal.aborted;
        if (!interrupted) {
          this.logger?.error(
            {
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
            },
            `agent runtime execution failed: ${result.content}`,
          );
        }
        input.onTerminal?.(interrupted ? "interrupted" : "failed");
        return result;
      }
      input.onTerminal?.("completed");
      return result;
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
     input.onTerminal?.(finalStatus);
     return { content: errorMessage, success: false };
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

/** 无工具桥时的空执行器（listTools 返回空数组，executeTool 拒绝）。 */
const emptyToolExecutor: import("../../runtime/runtime-tool-types.js").RuntimeToolExecutor = {
  listVisibleTools: () => [],
  executeTool: (call) => ({
    success: false,
    tool_name: call.toolName,
    summary: `工具不可用（未注入工具桥）: ${call.toolName}`,
    answer: null,
    output_type: "error",
    content: null,
    metadata: {},
    artifacts: [],
    llm_hint: null,
  }),
};

/** backend-ts MessageInfo → ChatMessage（保留 tool_calls/tool_call_id 结构化字段）。 */
function toStructuredChatMessage(message: import("../../../contracts/session.js").MessageInfo): ChatMessage {
  const result: ChatMessage = { role: message.role, content: message.content };
  if (message.name) {
    result.name = message.name;
  }
  if (message.tool_call_id) {
    result.tool_call_id = message.tool_call_id;
  }
  if (message.tool_calls && message.tool_calls.length > 0) {
    result.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
  }
  return result;
}
