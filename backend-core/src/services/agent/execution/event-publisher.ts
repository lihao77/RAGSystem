import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { Envelope, StateSyncPayload } from "../../../contracts/events.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type { AgentMailboxMessage } from "../../../contracts/storage/agent-mailbox-repository.js";
import type { ExecutionTaskStatus } from "../../../contracts/execution/execution.js";
import type { ClientEventPublisher } from "../../runtime/event-outbox/client-event-publisher.js";

interface ExecutionEventContext {
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  /**
   * 父 agent 的 call_id：child run 非空（指向发起委派的父 agent），root run 为空。
   * 新协议 agent_started/stream_output/tool 靠它（lineage.parent_call_id）把子 agent 嵌套到父——
   * agent-protocol execution-tree 据此重建 ReAct 树，缺失则子 agent 沦为平级 root。
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
    private readonly clientEvents: ClientEventPublisher,
  ) {}

  publishRunStarted(sessionId: string, runId: string, payload: { request_id?: string; task?: string; source?: string }): void {
    this.publish(sessionId, this.buildRunStarted(sessionId, runId, payload));
  }

  buildRunStarted(sessionId: string, runId: string, payload: { request_id?: string; task?: string; source?: string }): Envelope {
    return {
      type: "run_started",
      session_id: sessionId,
      run_id: runId,
      payload: { request_id: payload.request_id, task: payload.task, ...(payload.source ? { source: payload.source } : {}) },
    };
  }

  publishOutputMessageSaved(
    sessionId: string,
    runId: string | null | undefined,
    payload: { message_id: string; seq?: number; role?: string; request_id?: string; round_index?: number; content_parts?: MessageContentPart[] },
  ): void {
    this.publish(sessionId, this.buildOutputMessageSaved(sessionId, runId, payload));
  }

  buildOutputMessageSaved(
    sessionId: string,
    runId: string | null | undefined,
    payload: { message_id: string; seq?: number; role?: string; request_id?: string; round_index?: number; content_parts?: MessageContentPart[] },
  ): Envelope {
    return {
      type: "state_sync",
      session_id: sessionId,
      ...(runId ? { run_id: runId } : {}),
      payload: {
        category: "message_saved",
        ref: {
          message_id: payload.message_id,
          ...(payload.seq !== undefined ? { seq: payload.seq } : {}),
          ...(payload.role ? { role: payload.role } : {}),
          ...(payload.request_id ? { request_id: payload.request_id } : {}),
          ...(payload.round_index !== undefined ? { round_index: payload.round_index } : {}),
          ...(payload.content_parts ? { content_parts: payload.content_parts } : {}),
        },
      } satisfies StateSyncPayload,
    };
  }

  publishRootAgentStart(input: ExecutionEventContext & { task: string }): void {
    this.publish(input.sessionId, this.buildRootAgentStart(input));
  }

  buildRootAgentStart(input: ExecutionEventContext & { task: string }): Envelope {
    const { top, lineage } = contextMarkers(input);
    return {
      type: "agent_started",
      session_id: input.sessionId,
      ...top,
      payload: { phase: "start", task: input.task, display_name: input.agent.display_name || input.agent.agent_name, lineage },
    };
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
    }, false);
  }

  publishRunEnded(sessionId: string, runId: string, status: "interrupted" | "failed"): void {
    this.publish(sessionId, {
      type: "run_ended",
      session_id: sessionId,
      run_id: runId,
      payload: { status },
    }, false);
  }

  /**
   * 推单条已翻译的 Envelope。DurableClientEventPublisher 在同一事务内完成
   * protocol.envelope.v1 归档与 outbox 写入，再投递到 WS。
   */
  publishEnvelope(envelope: Envelope): void {
    this.publish(typeof envelope.session_id === "string" ? envelope.session_id : "", envelope);
  }

  /**
   * 推 delegate_call（委托执行指令）：落 outbox + realtime fanout（经统一投递路径，符合 outbox 架构契约）。
   * ws.ts 回放过滤 delegate_call（委托实时双向，重连时 in-flight 已失效，不回放）。
   * 由委托壳 Tool.call 在 gate 通过后调用，驱动宿主执行；与 tool_call（纯投影通知）分离。
   */
  publishDelegateCall(input: {
    sessionId: string;
    runId: string;
    callId: string;
    agentId: string;
    tool: string;
    arguments: Record<string, unknown>;
    parentCallId?: string | null;
  }): void {
    this.publishEnvelope({
      type: "delegate_call",
      session_id: input.sessionId,
      run_id: input.runId,
      call_id: input.callId,
      agent_id: input.agentId,
      payload: {
        tool: input.tool,
        input: input.arguments,
        phase: "request",
        ...(input.parentCallId ? { lineage: { parent_call_id: input.parentCallId } } : {}),
      },
    });
  }

  publishAgentMessage(input: {
    sessionId: string;
    runId: string;
    callId?: string | null;
    message: AgentMailboxMessage;
  }): void {
    const message = input.message;
    const metadata = message.metadata ?? {};
    const targetParentCallId = typeof metadata.target_parent_call_id === "string"
      ? metadata.target_parent_call_id
      : null;
    const targetParentAgentCallId = typeof metadata.target_parent_agent_call_id === "string"
      ? metadata.target_parent_agent_call_id
      : null;
    const targetRootRunId = typeof metadata.target_root_run_id === "string"
      ? metadata.target_root_run_id
      : null;
    const targetAgentName = typeof metadata.target_agent_name === "string"
      ? metadata.target_agent_name
      : null;
    this.publishEnvelope({
      type: "agent_message",
      session_id: input.sessionId,
      run_id: input.runId,
      ...(input.callId ? { call_id: input.callId } : {}),
      message_id: message.message_id,
      payload: {
        kind: message.kind,
        message_id: message.message_id,
        source_run_id: message.source_run_id,
        source_agent_call_id: message.source_agent_call_id,
        target_run_id: message.target_run_id,
        target_agent_call_id: message.target_agent_call_id,
        target_parent_call_id: targetParentCallId,
        target_parent_agent_call_id: targetParentAgentCallId,
        target_root_run_id: targetRootRunId,
        ...(targetAgentName ? { target_agent_name: targetAgentName } : {}),
        correlation_id: message.correlation_id,
        reply_to_message_id: message.reply_to_message_id,
        content: message.content_parts
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join(""),
        content_parts: message.content_parts,
        metadata: message.metadata,
      },
    });
  }


  private publish(sessionId: string, event: Envelope, requireRunLease = true): void {
    try {
      void Promise.resolve(this.clientEvents.publish(sessionId, event, {
        runId: typeof event.run_id === "string" ? event.run_id : null,
        aggregateType: typeof event.run_id === "string" ? "run" : "session",
        aggregateId: typeof event.run_id === "string" ? event.run_id : sessionId,
        ...(requireRunLease && typeof event.run_id === "string" ? { requireRunLease: true } : {}),
      })).catch(() => undefined);
    } catch {
      // Event delivery is best-effort here; durable replay covers reconnects.
    }
  }

}
