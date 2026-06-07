import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ExecutionTaskStatus } from "../../../contracts/execution.js";
import type { ContextCompressionEvent } from "../agent-context-compression-service.js";
import type { AgentSessionApplication } from "../agent-session-application.js";
import type { AgentRuntimeEvent } from "../agent-runtime-core.js";
import type { ConversationStore } from "../../stores/conversation-store.js";
import type { InMemoryEventBus } from "../../runtime/event-bus.js";
import { asString, isRecord, mirrorEventData } from "./helpers.js";

interface ExecutionEventContext {
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  agent: AgentConfig;
}

export class AgentExecutionEventPublisher {
  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly events: InMemoryEventBus,
    private readonly conversationStore: ConversationStore,
  ) {}

  publishSessionRunStarted(sessionId: string, runId: string, payload: Record<string, unknown>): void {
    this.events.publish(sessionId, {
      type: "session.run_started",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(payload),
    });
  }

  publishRunStartStep(sessionId: string, runId: string, payload: Record<string, unknown>): void {
    this.addExecutionStep(sessionId, runId, payload);
    this.events.publish(sessionId, {
      type: "execution.step",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(payload),
    });
  }

  publishRunStart(sessionId: string, runId: string, payload: Record<string, unknown>): void {
    this.events.publish(sessionId, {
      type: "run.start",
      session_id: sessionId,
      run_id: runId,
      ...mirrorEventData(payload),
    });
  }

  publishRootAgentStart(input: ExecutionEventContext & { task: string }): void {
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

  publishRootAgentEnd(input: ExecutionEventContext & { result: string; success: boolean }): void {
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
    this.events.publish(sessionId, {
      type: "user.interrupt",
      session_id: sessionId,
      ...(status.run_id ? { run_id: status.run_id } : {}),
      ...mirrorEventData(payload),
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

  publishRuntimeEvent(input: ExecutionEventContext, event: AgentRuntimeEvent): void {
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
    if (event.type === "runtime.assistant_intermediate") {
      this.persistReactIntermediate(input, {
        role: "assistant",
        msgType: "intent",
        content: event.data.content,
        round: event.data.round,
        agentName: event.data.agent_name,
      });
      return;
    }
    if (event.type === "runtime.observation_complete") {
      this.persistReactIntermediate(input, {
        role: "user",
        msgType: "observation",
        content: event.data.content,
        round: event.data.round,
        agentName: event.data.agent_name,
      });
      return;
    }
    if (event.type === "runtime.intent_complete") {
      const payload = {
        kind: "intent",
        phase: "complete",
        call_id: input.rootCallId,
        parent_call_id: null,
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
      this.addExecutionStep(input.sessionId, input.runId, payload);
      this.events.publish(input.sessionId, {
        type: "execution.step",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData(payload),
      });
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
      this.addExecutionStep(input.sessionId, input.runId, payload);
      this.events.publish(input.sessionId, {
        type: "execution.step",
        session_id: input.sessionId,
        run_id: input.runId,
        ...mirrorEventData(payload),
      });
      return;
    }
  }

  addExecutionStep(sessionId: string, runId: string, payload: Record<string, unknown>): void {
    this.conversationStore.addRunStep({
      sessionId,
      runId,
      stepType: "execution.step",
      payload,
    });
  }

  private persistReactIntermediate(
    input: Omit<ExecutionEventContext, "rootCallId">,
    event: {
      role: "assistant" | "user";
      msgType: "intent" | "observation";
      content: string;
      round: number;
      agentName: string;
    },
  ): void {
    if (!event.content.trim()) {
      return;
    }
    this.sessions.addMessage({
      sessionId: input.sessionId,
      role: event.role,
      content: event.content,
      threadKey: "root",
      childAgentId: null,
      metadata: {
        react_intermediate: true,
        msg_type: event.msgType,
        round: event.round + 1,
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
        agent: input.agent.agent_name,
        agent_name: event.agentName,
        thread_key: "root",
        conversation_scope: "root",
        visible_to_user: true,
        execution_kind: "agent_stream",
      },
    });
  }
}
