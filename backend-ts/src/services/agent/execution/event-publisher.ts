import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { Envelope, StateSyncPayload, StreamOutputPayload } from "../../../contracts/events.js";
import type { ExecutionTaskStatus } from "../../../contracts/execution.js";
import type { ContextCompressionEvent } from "../context-compression/index.js";
import type { AgentSessionApplication } from "../../sessions/index.js";
import type { AgentRuntimeEvent } from "../kernel/contracts.js";
import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import type { IConversationTransactionRunner } from "../../../contracts/conversation-store/index.js";
import type {
  DurableClientEventPublisher,
  RecordedClientEvent,
} from "../../runtime/event-outbox/client-event-publisher.js";
import { asString, isRecord } from "./helpers.js";

interface ExecutionEventContext {
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  /**
   * 父 agent 的 call_id：child run 非空（指向发起委派的父 agent），root run 为空。
   * 新协议 agent_started/stream_output/tool 靠它（lineage.parent_call_id）把子 agent 嵌套到父——
   * core execution-tree 据此重建 ReAct 树，缺失则子 agent 沦为平级 root。
   */
  parentCallId?: string | null | undefined;
  agent: AgentConfig;
  // run 自己的 thread 归属：root run="root"，child run="child:<id>"。
  // observation/intent 消息按此落到对应 thread，续聊 prepare 才能重建完整上下文。
  threadKey: string;
  childAgentId?: string | null | undefined;
}

/**
 * 把 ExecutionEventContext 的公共字段投影到 envelope 顶层 + payload.lineage。
 * child run 带 lineage.parent_call_id（挂父）；root run 不带（顶层 root）。
 */
function contextMarkers(input: ExecutionEventContext): {
  top: { run_id: string; agent_id: string; call_id: string };
  lineage: { parent_call_id?: string } | undefined;
} {
  const lineage = input.parentCallId ? { parent_call_id: input.parentCallId } : undefined;
  return {
    top: { run_id: input.runId, agent_id: input.agent.agent_name, call_id: input.rootCallId },
    lineage,
  };
}

export class AgentExecutionEventPublisher {
  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly clientEvents: DurableClientEventPublisher,
    private readonly conversationStore: IConversationTransactionRunner,
  ) {}

  publishRunStarted(sessionId: string, runId: string, payload: { request_id?: string; task?: string }): void {
    this.publish(sessionId, {
      type: "run_started",
      session_id: sessionId,
      run_id: runId,
      payload: { request_id: payload.request_id, task: payload.task },
    });
  }

  publishOutputMessageSaved(
    sessionId: string,
    runId: string | null | undefined,
    payload: { message_id: string; seq?: number; role?: string },
  ): void {
    this.publish(sessionId, {
      type: "state_sync",
      session_id: sessionId,
      ...(runId ? { run_id: runId } : {}),
      payload: {
        category: "message_saved",
        ref: { message_id: payload.message_id, ...(payload.seq !== undefined ? { seq: payload.seq } : {}) },
      } satisfies StateSyncPayload,
    });
  }

  publishRootAgentStart(input: ExecutionEventContext & { task: string }): void {
    const { top, lineage } = contextMarkers(input);
    this.publish(input.sessionId, {
      type: "agent_started",
      session_id: input.sessionId,
      ...top,
      payload: { phase: "start", task: input.task, lineage },
    });
  }

  publishRootAgentEnd(input: ExecutionEventContext & { result: string; success: boolean }): void {
    const { top, lineage } = contextMarkers(input);
    this.publish(input.sessionId, {
      type: "agent_ended",
      session_id: input.sessionId,
      ...top,
      payload: { phase: "end", result: input.result.slice(0, 500), success: input.success, lineage },
    });
  }

  publishUserInterrupt(status: ExecutionTaskStatus, reason: string): void {
    const sessionId = status.session_id;
    if (!sessionId) {
      return;
    }
    this.publish(sessionId, {
      type: "abort",
      session_id: sessionId,
      ...(status.run_id ? { run_id: status.run_id } : {}),
      payload: { scope: "run", reason },
    });
  }

  publishContextCompressionEvent(
    input: Omit<ExecutionEventContext, "rootCallId" | "parentCallId">,
    event: ContextCompressionEvent,
  ): void {
    const detail = {
      ...event.data,
      run_id: input.runId,
      task_id: input.taskId,
      request_id: input.requestId,
      agent_name: input.agent.agent_name,
    };
    // run_step 表（API 契约）仍存旧 kind=context 结构；下行事件改为 state_sync(compression)。
    this.addExecutionStepAndPublish(
      input.sessionId,
      input.runId,
      { kind: "context", phase: event.type === "context.compression_start" ? "compression_start" : "compression_summary", ...detail },
      {
        type: "state_sync",
        session_id: input.sessionId,
        run_id: input.runId,
        agent_id: input.agent.agent_name,
        payload: { category: "compression", detail } satisfies StateSyncPayload,
      },
    );
  }

  publishRuntimeEvent(input: ExecutionEventContext, event: AgentRuntimeEvent): void {
    const { top, lineage } = contextMarkers(input);
    if (event.type === "runtime.first_token") {
      this.publish(input.sessionId, {
        type: "stream_output",
        session_id: input.sessionId,
        ...top,
        payload: { phase: "first_token", elapsed_ms: event.data.elapsed_ms } satisfies StreamOutputPayload,
      });
      return;
    }
    if (event.type === "runtime.output_delta") {
      this.publish(input.sessionId, {
        type: "stream_output",
        session_id: input.sessionId,
        ...top,
        payload: { phase: "delta", content: event.data.content } satisfies StreamOutputPayload,
      });
      return;
    }
    if (event.type === "runtime.error") {
      this.publish(input.sessionId, {
        type: "error",
        session_id: input.sessionId,
        ...top,
        payload: { code: "RuntimeError", message: event.data.message },
      });
      return;
    }
    if (event.type === "runtime.intent_delta") {
      this.publish(input.sessionId, {
        type: "stream_output",
        session_id: input.sessionId,
        ...top,
        payload: { phase: "intent_delta", content: event.data.content, round: event.data.round } satisfies StreamOutputPayload,
      });
      return;
    }
    if (event.type === "runtime.assistant_intermediate") {
      this.persistReactMessage(input, event.data.message, "intent", event.data.round, event.data.agent_name);
      return;
    }
    if (event.type === "runtime.observation_complete") {
      for (const message of event.data.messages) {
        this.persistReactMessage(input, message, "observation", event.data.round, event.data.agent_name);
      }
      return;
    }
    if (event.type === "runtime.intent_complete") {
      this.publishIntentComplete(input, event);
      return;
    }
    if (event.type === "runtime.tool_call") {
      const toolCallId = event.data.tool_call_id;
      // run_step 表存旧 kind=tool 结构（API 契约：buildSynchronousResult 按 kind/phase 读取）。
      const stepPayload = {
        kind: "tool",
        phase: "start",
        step_id: `${toolCallId}:tool`,
        parent_step_id: `${input.rootCallId}:round:${event.data.round}`,
        agent_name: event.data.agent_name,
        agent_display_name: input.agent.display_name || event.data.agent_name,
        tool_name: event.data.tool_name,
        call_id: toolCallId,
        tool_call_id: toolCallId,
        parent_call_id: input.rootCallId,
        arguments: event.data.arguments,
        round: event.data.round,
        status: "running",
        order: event.data.order,
        round_index: event.data.round_index,
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      };
      this.addExecutionStepAndPublish(input.sessionId, input.runId, stepPayload, {
        type: "tool_call",
        session_id: input.sessionId,
        run_id: input.runId,
        call_id: toolCallId,
        agent_id: event.data.agent_name,
        payload: {
          tool: event.data.tool_name,
          input: event.data.arguments,
          mode: "projection",
          phase: "start",
          status: "running",
          lineage,
        },
      });
      return;
    }
    if (event.type === "runtime.tool_result") {
      const toolCallId = event.data.tool_call_id;
      const approvalMessage = asString(event.data.metadata.approval_message);
      const approvalMetadata = isRecord(event.data.metadata.approval) ? event.data.metadata.approval : null;
      const stepPayload = {
        kind: "tool",
        phase: "end",
        step_id: `${toolCallId}:tool`,
        parent_step_id: `${input.rootCallId}:round:${event.data.round}`,
        agent_name: event.data.agent_name,
        agent_display_name: input.agent.display_name || event.data.agent_name,
        tool_name: event.data.tool_name,
        call_id: toolCallId,
        tool_call_id: toolCallId,
        parent_call_id: input.rootCallId,
        round: event.data.round,
        status: event.data.success ? "success" : "error",
        success: event.data.success,
        summary: event.data.summary,
        observation: event.data.observation,
        result_preview: event.data.observation || event.data.summary,
        raw_result: event.data.raw_result,
        raw_result_ref: event.data.raw_result_ref,
        raw_result_available: event.data.raw_result_available,
        elapsed_time: event.data.elapsed_time,
        order: event.data.order,
        round_index: event.data.round_index,
        ...(approvalMessage ? { approval_message: approvalMessage } : {}),
        ...(approvalMetadata ? { approval: approvalMetadata } : {}),
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      };
      const approvalStatus = asString(approvalMetadata?.status);
      this.addExecutionStepAndPublish(input.sessionId, input.runId, stepPayload, {
        type: "tool_result",
        session_id: input.sessionId,
        run_id: input.runId,
        call_id: toolCallId,
        agent_id: event.data.agent_name,
        payload: {
          tool: event.data.tool_name,
          mode: "projection",
          phase: "end",
          ok: event.data.success,
          status: event.data.success ? "succeeded" : "failed",
          observation: event.data.observation,
          summary: event.data.summary,
          elapsed_ms: typeof event.data.elapsed_time === "number" ? event.data.elapsed_time * 1000 : undefined,
          ...(approvalStatus === "pending" || approvalStatus === "granted" || approvalStatus === "denied"
            ? { approval: { status: approvalStatus, ...(approvalMessage ? { message: approvalMessage } : {}) } }
            : {}),
          lineage,
        },
      });
    }
  }

  private publishIntentComplete(
    input: ExecutionEventContext,
    event: Extract<AgentRuntimeEvent, { type: "runtime.intent_complete" }>,
  ): void {
    const { top, lineage } = contextMarkers(input);
    const stepPayload = {
      kind: "intent",
      phase: "complete",
      call_id: input.rootCallId,
      parent_call_id: input.parentCallId ?? null,
      step_id: `${input.rootCallId}:round:${event.data.round}`,
      parent_step_id: `${input.rootCallId}:run`,
      agent_name: event.data.agent_name,
      agent_display_name: input.agent.display_name || event.data.agent_name,
      content: event.data.content,
      round: event.data.round,
      status: "completed",
      run_id: input.runId,
      task_id: input.taskId,
      request_id: input.requestId,
    };
    const records: RecordedClientEvent[] = this.conversationStore.runInTransaction((tx) => {
      tx.addRunStep({
        sessionId: input.sessionId,
        runId: input.runId,
        stepType: "execution.step",
        payload: stepPayload,
      });
      return [
        this.clientEvents.recordInTransaction(
          tx,
          input.sessionId,
          {
            type: "stream_output",
            session_id: input.sessionId,
            ...top,
            payload: { phase: "intent_complete", content: event.data.content, round: event.data.round } satisfies StreamOutputPayload,
          },
          { runId: input.runId, aggregateType: "run", aggregateId: input.runId },
        ),
      ];
    });
    this.clientEvents.deliver(records);
  }

  private publish(sessionId: string, event: Envelope): void {
    this.clientEvents.publish(sessionId, event, {
      runId: typeof event.run_id === "string" ? event.run_id : null,
      aggregateType: typeof event.run_id === "string" ? "run" : "session",
      aggregateId: typeof event.run_id === "string" ? event.run_id : sessionId,
    });
  }

  /**
   * run_step 表（API 契约，旧 execution.step 结构）+ outbox 事件（新 envelope）原子写入。
   * stepPayload 给 listRunSteps/buildSynchronousResult；envelope 给 WS 实时流 + 回放。
   */
  addExecutionStepAndPublish(
    sessionId: string,
    runId: string,
    stepPayload: Record<string, unknown>,
    envelope: Envelope,
  ): void {
    const record = this.conversationStore.runInTransaction((tx) => {
      tx.addRunStep({
        sessionId,
        runId,
        stepType: "execution.step",
        payload: stepPayload,
      });
      return this.clientEvents.recordInTransaction(tx, sessionId, envelope, {
        runId,
        aggregateType: "run",
        aggregateId: runId,
      });
    });
    this.clientEvents.deliver([record]);
  }

  /**
   * 仅写 run_step 表（API 契约），不发 outbox 事件。child agent 的 subtask step 用此——
   * 其 agent_started/agent_ended 事件由 delegation publishAgentCallStart/End 独占发，避免双发。
   */
  addExecutionStepOnly(sessionId: string, runId: string, stepPayload: Record<string, unknown>): void {
    this.conversationStore.runInTransaction((tx) => {
      tx.addRunStep({
        sessionId,
        runId,
        stepType: "execution.step",
        payload: stepPayload,
      });
    });
  }

  private persistReactMessage(
    input: Omit<ExecutionEventContext, "rootCallId" | "parentCallId">,
    message: ChatMessage,
    msgType: "intent" | "observation",
    round: number,
    agentName: string,
  ): void {
    // 空 content 且无 tool_calls 跳过（FC 工具调用轮 content 空但有结构化 tool_calls，需落库）。
    const hasToolCalls = Boolean(message.tool_calls && message.tool_calls.length > 0);
    if (!message.content.trim() && !hasToolCalls) {
      return;
    }
    this.sessions.addMessage({
      sessionId: input.sessionId,
      role: message.role,
      content: message.content,
      toolCalls: message.tool_calls,
      toolCallId: message.tool_call_id,
      name: message.name,
      threadKey: input.threadKey,
      childAgentId: input.childAgentId ?? null,
      metadata: {
        react_intermediate: true,
        msg_type: msgType,
        round: round + 1,
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
        agent: input.agent.agent_name,
        agent_name: agentName,
        thread_key: input.threadKey,
        conversation_scope: input.childAgentId ? "child" : "root",
        visible_to_user: true,
        execution_kind: "agent_stream",
      },
    });
  }
}
