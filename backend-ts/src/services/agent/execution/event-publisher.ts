import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ClientEvent } from "../../../contracts/events.js";
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
  agent: AgentConfig;
  // run 自己的 thread 归属：root run="root"，child run="child:<id>"。
  // observation/intent 消息按此落到对应 thread，续聊 prepare 才能重建完整上下文。
  threadKey: string;
  childAgentId?: string | null;
}

export class AgentExecutionEventPublisher {
  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly clientEvents: DurableClientEventPublisher,
    private readonly conversationStore: IConversationTransactionRunner,
  ) {}

  publishSessionRunStarted(sessionId: string, runId: string, payload: Record<string, unknown>): void {
    this.publish(sessionId, {
      type: "session.run_started",
      session_id: sessionId,
      run_id: runId,
      data: payload,
    });
  }

  publishRunStartStep(sessionId: string, runId: string, payload: Record<string, unknown>): void {
    this.addExecutionStepAndPublish(sessionId, runId, payload, {
      type: "execution.step",
      session_id: sessionId,
      run_id: runId,
      data: payload,
    });
  }

  publishRunStart(sessionId: string, runId: string, payload: Record<string, unknown>): void {
    this.publish(sessionId, {
      type: "run.start",
      session_id: sessionId,
      run_id: runId,
      data: payload,
    });
  }

  publishOutputMessageSaved(
    sessionId: string,
    runId: string | null | undefined,
    payload: Record<string, unknown>,
  ): void {
    this.publish(sessionId, {
      type: "output.message_saved",
      session_id: sessionId,
      ...(runId ? { run_id: runId } : {}),
      data: payload,
    });
  }

  publishRootAgentStart(input: ExecutionEventContext & { task: string }): void {
    const agentName = input.agent.agent_name;
    const displayName = input.agent.display_name || agentName;
    this.publish(input.sessionId, {
      type: "agent.start",
      session_id: input.sessionId,
      run_id: input.runId,
      agent_name: agentName,
      call_id: input.rootCallId,
      data: {
        agent_name: agentName,
        task: input.task,
        description: input.task,
        metadata: {},
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      },
    });
    this.publish(input.sessionId, {
      type: "call.agent.start",
      session_id: input.sessionId,
      run_id: input.runId,
      agent_name: agentName,
      call_id: input.rootCallId,
      data: {
        agent_name: agentName,
        description: input.task,
        agent_display_name: displayName,
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      },
    });
  }

  publishRootAgentEnd(input: ExecutionEventContext & { result: string; success: boolean }): void {
    const agentName = input.agent.agent_name;
    const displayName = input.agent.display_name || agentName;
    this.publish(input.sessionId, {
      type: "call.agent.end",
      session_id: input.sessionId,
      run_id: input.runId,
      agent_name: agentName,
      call_id: input.rootCallId,
      data: {
        agent_name: agentName,
        result: input.result.slice(0, 500),
        success: input.success,
        agent_display_name: displayName,
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      },
    });
  }

  publishUserInterrupt(status: ExecutionTaskStatus, reason: string): void {
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
    this.publish(sessionId, {
      type: "user.interrupt",
      session_id: sessionId,
      ...(status.run_id ? { run_id: status.run_id } : {}),
      data: payload,
    });
  }

  publishContextCompressionEvent(
    input: Omit<ExecutionEventContext, "rootCallId">,
    event: ContextCompressionEvent,
  ): void {
    const payload = {
      ...event.data,
      run_id: input.runId,
      task_id: input.taskId,
      request_id: input.requestId,
      agent_name: input.agent.agent_name,
    };
    const clientEvent: ClientEvent = {
      type: event.type,
      session_id: input.sessionId,
      run_id: input.runId,
      agent_name: input.agent.agent_name,
      data: payload,
    };
    if (event.type === "context.compression_start") {
      this.addExecutionStepAndPublish(input.sessionId, input.runId, {
        kind: "context",
        phase: "compression_start",
        ...payload,
      }, clientEvent);
      return;
    }
    if (event.type === "context.compression_summary") {
      this.addExecutionStepAndPublish(input.sessionId, input.runId, {
        kind: "context",
        phase: "compression_summary",
        ...payload,
      }, clientEvent);
      return;
    }
    this.publish(input.sessionId, clientEvent);
  }

  publishRuntimeEvent(input: ExecutionEventContext, event: AgentRuntimeEvent): void {
    // child run 的事件带上 parent_call_id/call_id（=子 run 的 rootCallId=agentCallId）：
    // 前端 isMasterEvent 据此把子 agent 输出挂到对应 subtask，不污染主对话消息。
    const childMarkers = input.childAgentId
      ? { parent_call_id: input.rootCallId, call_id: input.rootCallId }
      : {};
    if (event.type === "runtime.first_token") {
      this.publish(input.sessionId, {
        type: "llm.first_token",
        session_id: input.sessionId,
        run_id: input.runId,
        ...childMarkers,
        data: {
          elapsed_ms: event.data.elapsed_ms,
          agent_name: event.data.agent_name,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
        },
      });
      return;
    }
    if (event.type === "runtime.output_delta") {
      this.publish(input.sessionId, {
        type: "output.chunk",
        session_id: input.sessionId,
        run_id: input.runId,
        ...childMarkers,
        data: {
          content: event.data.content,
          agent_name: event.data.agent_name,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
        },
      });
      return;
    }
    if (event.type === "runtime.error") {
      const payload = {
        error: event.data.message,
        message: event.data.message,
        agent_name: event.data.agent_name,
        error_type: "RuntimeError",
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
      };
      this.publish(input.sessionId, {
        type: "error",
        session_id: input.sessionId,
        run_id: input.runId,
        ...childMarkers,
        agent_name: event.data.agent_name,
        error: event.data.message,
        data: payload,
      });
      return;
    }
    if (event.type === "runtime.intent_delta") {
      this.publish(input.sessionId, {
        type: "agent.intent_delta",
        session_id: input.sessionId,
        run_id: input.runId,
        ...childMarkers,
        data: {
          content: event.data.content,
          agent_name: event.data.agent_name,
          round: event.data.round,
          run_id: input.runId,
          task_id: input.taskId,
          request_id: input.requestId,
        },
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
      const payload = {
        kind: "tool",
        phase: "start",
        step_id: `${event.data.tool_call_id}:tool`,
        parent_step_id: `${input.rootCallId}:round:${event.data.round}`,
        agent_name: event.data.agent_name,
        agent_display_name: input.agent.display_name || event.data.agent_name,
        tool_name: event.data.tool_name,
        call_id: event.data.tool_call_id,
        tool_call_id: event.data.tool_call_id,
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
      this.addExecutionStepAndPublish(input.sessionId, input.runId, payload, {
        type: "execution.step",
        session_id: input.sessionId,
        run_id: input.runId,
        data: payload,
      });
      return;
    }
    if (event.type === "runtime.tool_result") {
      const approvalMessage = asString(event.data.metadata.approval_message);
      const approvalMetadata = isRecord(event.data.metadata.approval) ? event.data.metadata.approval : null;
      const payload = {
        kind: "tool",
        phase: "end",
        step_id: `${event.data.tool_call_id}:tool`,
        parent_step_id: `${input.rootCallId}:round:${event.data.round}`,
        agent_name: event.data.agent_name,
        agent_display_name: input.agent.display_name || event.data.agent_name,
        tool_name: event.data.tool_name,
        call_id: event.data.tool_call_id,
        tool_call_id: event.data.tool_call_id,
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
      this.addExecutionStepAndPublish(input.sessionId, input.runId, payload, {
        type: "execution.step",
        session_id: input.sessionId,
        run_id: input.runId,
        data: payload,
      });
    }
  }

  private publishIntentComplete(
    input: ExecutionEventContext,
    event: Extract<AgentRuntimeEvent, { type: "runtime.intent_complete" }>,
  ): void {
    const payload = {
      kind: "intent",
      phase: "complete",
      call_id: input.rootCallId,
      parent_call_id: input.childAgentId ? input.rootCallId : null,
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
        payload,
      });
      return [
        this.clientEvents.recordInTransaction(tx, input.sessionId, {
          type: "execution.step",
          session_id: input.sessionId,
          run_id: input.runId,
          data: payload,
        }, { runId: input.runId, aggregateType: "run", aggregateId: input.runId }),
        this.clientEvents.recordInTransaction(tx, input.sessionId, {
          type: "agent.intent_complete",
          session_id: input.sessionId,
          run_id: input.runId,
          data: {
            content: event.data.content,
            agent_name: event.data.agent_name,
            round: event.data.round,
            run_id: input.runId,
            task_id: input.taskId,
            request_id: input.requestId,
          },
        }, { runId: input.runId, aggregateType: "run", aggregateId: input.runId }),
      ];
    });
    this.clientEvents.deliver(records);
  }

  private publish(sessionId: string, event: ClientEvent): void {
    this.clientEvents.publish(sessionId, event, {
      runId: typeof event.run_id === "string" ? event.run_id : null,
      aggregateType: typeof event.run_id === "string" ? "run" : "session",
      aggregateId: typeof event.run_id === "string" ? event.run_id : sessionId,
    });
  }

  addExecutionStepAndPublish(
    sessionId: string,
    runId: string,
    payload: Record<string, unknown>,
    event: ClientEvent,
  ): void {
    const record = this.conversationStore.runInTransaction((tx) => {
      tx.addRunStep({
        sessionId,
        runId,
        stepType: "execution.step",
        payload,
      });
      return this.clientEvents.recordInTransaction(tx, sessionId, event, {
        runId,
        aggregateType: "run",
        aggregateId: runId,
      });
    });
    this.clientEvents.deliver([record]);
  }

  private persistReactMessage(
    input: Omit<ExecutionEventContext, "rootCallId">,
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
