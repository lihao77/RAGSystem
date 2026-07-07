import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { AgentExecuteResult, AgentRunStartResult, ExecutionTaskStatus } from "../../../contracts/execution.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { AgentSessionApplication } from "../../sessions/index.js";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";
import { executeRunWithSdk } from "../sdk/runtime-adapter.js";
import type { DurableClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";
import type { OutboxDispatcher } from "../../runtime/event-outbox/dispatcher.js";
import type { BackendToolsDeps } from "../../../tools/registry.js";
import type { CodeExecutionToolService } from "../../../tools/CodeExecutionTool/CodeExecution.js";
import type { TaskToolService } from "../../../tools/TaskTools/TaskExecution.js";
import type { PermissionPolicyService } from "../../runtime/permission-policy-service.js";
import type { PendingInteractionService } from "../../runtime/pending-interaction-service.js";
import type { HostToolRegistry } from "../../runtime/host-tool-registry.js";
import type { DelegationPendingService } from "../../runtime/delegation-pending-service.js";
import type { AgentMetricsCollector } from "../metrics/metrics-collector.js";
import type { AgentCompressionService } from "../context-compression/compression-service.js";
import type { IMessageStore, IRunStore, ISessionStore } from "../../../contracts/conversation-store/index.js";
import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import { AgentExecutionEventPublisher } from "./event-publisher.js";
import {
  asString,
  buildRunningExecutionStatus,
  renderBackgroundNotification,
} from "./helpers.js";
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
    private readonly dataRoot: string,
   private readonly toolsDeps: Omit<BackendToolsDeps, "agent" | "teamName"> | null,
   private readonly codeExecutionTools: CodeExecutionToolService | null,
   private readonly taskTools: TaskToolService | null,
   /** 已加载的 provider 列表提供者（投影层解析 tier.provider 引用用）。 */
   private readonly providersProvider: () => ModelProviderConfig[],
   private readonly backgroundTasks: BackgroundTaskService | null,
    private readonly statusTracker: AgentExecutionStatusTracker,
    private readonly eventPublisher: AgentExecutionEventPublisher,
    private readonly outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">,
    private readonly clientEvents: DurableClientEventPublisher,
    private readonly permissionPolicy: PermissionPolicyService,
    private readonly pendingInteractions: PendingInteractionService,
    private readonly hostToolRegistry: HostToolRegistry,
    private readonly delegationPending: DelegationPendingService,
    private readonly logger: AgentExecutionLogger | null,
    private readonly hooks: ((registry: HookRegistry) => void) | null,
    private readonly metricsCollector: AgentMetricsCollector | null = null,
    private readonly compressionService: AgentCompressionService | null = null,
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
    /**
     * selectLlm 解析结果（仅当前端真选了 provider+model 时非 null）：整体替换 default 档，
     * projection 用所选 provider 的窗口/参数；null/不传 → projection 走 agent.default tier
     *（保留 tier 的 max_context_tokens 等配置，budget 据此计算）。
     */
    selectedLlm?: { provider: ModelProviderConfig; modelName: string } | null;
    existingUserMessageId?: string | undefined;
    userMessageSavedPayload?: Record<string, unknown> | undefined;
    persistUserMessage?: {
      metadata?: Record<string, unknown> | undefined;
    } | undefined;
    runStartExtra?: Record<string, unknown> | undefined;
    startStepExtra?: Record<string, unknown> | undefined;
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
      ...(input.selectedLlm ? { selectedLlm: input.selectedLlm } : {}),
      threadKey: "root",
      parentRunId: null,
      childAgentId: null,
      userMessageId: existingUserMessageId,
      executionKind: input.executionKind,
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
    /**
     * selectLlm 解析结果（仅当前端真选了 provider+model 时非 null）：整体替换 default 档。
     * 不传（如 child delegation run）→ null → projection 走 agent.default tier。
     */
    selectedLlm?: { provider: ModelProviderConfig; modelName: string } | null;
    // run 自己的归属：root run threadKey="root"、parent=null；child run threadKey="child:<id>"、
    // parent_run_id/child_agent_id 指向父。执行链路据此统一落库，无 root/child 分支。
    threadKey: string;
    parentRunId?: string | null;
    parentCallId?: string | null | undefined;
    childAgentId?: string | null;
    userMessageId?: string | undefined;
    executionKind?: string | undefined;
    finalMetadataExtra?: Record<string, unknown> | undefined;
    // 终态回调（替代直接耦合 statusTracker）：root 由 startRun 壳传绑定 statusTracker 的回调，
    // child 不传。executeRun 自己用 startedAt 算 execution_time，不依赖外部 status 对象。
    onTerminal?: (finalStatus: "completed" | "failed" | "interrupted") => void;
  }): Promise<{ content: string; success: boolean }> {
    // 性能监控落库:统一在此处采集(root/child 都走 executeRun),不挂 onTerminal——
    // child run 不绑 onTerminal,挂那里会漏采子智能体/委托调用。token/工具用量来自 executeRunWithSdk 返回值。
    const recordMetric = (
      finalStatus: string,
      tokenUsage: { inputTokens: number; outputTokens: number },
      toolCalls: Record<string, number>,
      errorType: string | null,
    ): void => {
      if (!this.metricsCollector) {
        return;
      }
      const finishedAt = new Date();
      this.metricsCollector.recordRun({
        agentName: input.agent.agent_name,
        model: input.modelName,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        executionKind: input.executionKind ?? "agent_stream",
        status: finalStatus,
        durationMs: finishedAt.getTime() - input.startedAt.getTime(),
        tokenIn: tokenUsage.inputTokens,
        tokenOut: tokenUsage.outputTokens,
        toolUsage: toolCalls,
        errorType,
        startedAt: input.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      });
    };
    try {
      const sessionMetadata = this.sessions.getSession(input.sessionId)?.metadata ?? {};
      const executionKind = input.executionKind ?? "agent_stream";
      // 后台任务完成通知落库为 user 消息（系统注入的上下文）；SDK 从 store 读取对话历史时一并看到，
      // backend 不再组装消息数组传给 SDK。
      this.persistBackgroundNotifications(input.sessionId, input.threadKey);

      const result = await executeRunWithSdk(
       {
          // run-engine 的 conversationStore 实际是完整 ConversationStore（构造时传入窄类型）。
          conversationStore: this.conversationStore as unknown as ConversationStore,
          toolsDeps: this.toolsDeps ?? emptyToolsDeps,
          codeExecutionTools: this.codeExecutionTools,
          taskTools: this.taskTools,
          eventPublisher: this.eventPublisher,
          clientEvents: this.clientEvents,
          providers: this.providersProvider(),
          dataRoot: this.dataRoot,
          permissionPolicy: this.permissionPolicy,
          pendingInteractions: this.pendingInteractions,
          hostToolRegistry: this.hostToolRegistry,
          delegationPending: this.delegationPending,
          ...(this.hooks ? { hooks: this.hooks } : {}),
          ...(this.compressionService ? { compressionService: this.compressionService } : {}),
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
         ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
         sessionMetadata,
         ...(input.executionKind !== undefined ? { executionKind } : {}),
          ...(asString(sessionMetadata.user_id) ? { userId: asString(sessionMetadata.user_id) } : {}),
        signal: input.abortController.signal,
         selectedLlm: input.selectedLlm ?? null,
         // 最终 assistant 消息的调用点元数据：execution_kind + finalMetadataExtra（retry_of_* 等）。
         messageMetadata: { execution_kind: executionKind, ...(input.finalMetadataExtra ?? {}) },
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
        recordMetric(
          interrupted ? "interrupted" : "failed",
          result.tokenUsage,
          result.toolCalls,
          interrupted ? null : result.content || null,
        );
        input.onTerminal?.(interrupted ? "interrupted" : "failed");
        return result;
      }
      recordMetric("completed", result.tokenUsage, result.toolCalls, null);
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
      recordMetric(finalStatus, { inputTokens: 0, outputTokens: 0 }, {}, interrupted ? null : errorMessage);
     input.onTerminal?.(finalStatus);
     return { content: errorMessage, success: false };
    }
 }

  private persistBackgroundNotifications(sessionId: string, threadKey: string): void {
    const payloads = this.backgroundTasks?.drainPendingNotifications(sessionId) ?? [];
    for (const payload of payloads) {
      const content = renderBackgroundNotification(payload);
      if (!content.trim()) {
        continue;
      }
      this.conversationStore.addMessage({
        sessionId,
        role: "user",
        content,
        threadKey,
        metadata: { source: "background_notification" },
      });
    }
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

/** 无工具依赖时的空实现（所有 service 为 null，工具工厂返回 []）。 */
const emptyToolsDeps: Omit<BackendToolsDeps, "agent" | "teamName"> = {
  memoryTools: null as unknown as import("../../../tools/MemoryTools/MemoryExecution.js").MemoryToolService,
  pendingInteractions: null,
  documentTools: null,
  bashTools: null,
  taskTools: null,
  searchTools: null,
  vectorLibrary: null,
  mcp: null,
  codeExecutionTools: null,
  skillTools: null,
  getAgentDelegation: () => null,
};
