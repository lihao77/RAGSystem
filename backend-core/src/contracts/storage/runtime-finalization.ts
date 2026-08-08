import type { AddMessageInput } from "../conversation-store/index.js";
import { MSG_TYPE } from "../message-kinds.js";
import type { MessageInfo } from "../session/session.js";
import { PROTOCOL_VERSION, type AssistantContentPart, type Envelope } from "@ragsystem/agent-protocol";
import type { RuntimeRecordEnvelopeInput } from "./runtime-storage.js";

export type TerminalAssistantStatus = "failed" | "interrupted";
export type TerminalRunStatus = "completed" | TerminalAssistantStatus;

export interface TerminalRunIdentity {
  sessionId: string;
  runId: string;
  agentCallId: string;
  lineageParentCallId: string | null;
  agentName: string;
  agentDisplayName: string;
}

/**
 * Builds the durable assistant message that closes a failed/interrupted Run.
 * The message is intentionally non-empty so it remains both user-visible and
 * unambiguous in the next model context.
 */
export function buildTerminalAssistantMessage(input: {
  sessionId: string;
  runId: string;
  threadKey: string;
  agentName: string;
  terminalStatus: TerminalAssistantStatus;
  reason: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}): AddMessageInput & { messageId: string } {
  const reason = input.reason.trim().slice(0, 2_000)
    || (input.terminalStatus === "failed" ? "未提供失败原因" : "未提供中断原因");
  const displayReason = terminalReasonDisplay(input.terminalStatus, reason);
  const content = input.terminalStatus === "failed"
    ? `本次运行执行失败：${displayReason}`
    : `本次运行已中断，未生成最终答案。原因：${displayReason}`;
  return {
    messageId: input.messageId?.trim() || `${input.runId}:terminal`,
    sessionId: input.sessionId,
    role: "assistant",
    content,
    contentParts: [{ type: "text", text: content }],
    threadKey: input.threadKey,
    metadata: {
      agent_name: input.agentName,
      run_id: input.runId,
      agent: input.agentName,
      thread_key: input.threadKey,
      ...(input.metadata ?? {}),
      msg_type: MSG_TYPE.RUN_TERMINAL,
      terminal_status: input.terminalStatus,
      terminal_reason: reason,
      visible_to_user: true,
      ...(input.terminalStatus === "failed" ? { run_failed: true } : { interrupted: true }),
    },
  };
}

export function terminalReasonDisplay(status: TerminalAssistantStatus, reason: string): string {
  if (status !== "interrupted") return reason;
  return {
    session_stopped: "用户主动停止运行",
    backend_restarted: "后端重启导致运行中断",
    run_lease_expired: "运行租约过期导致运行中断",
  }[reason] ?? reason;
}

export function buildTerminalToolMessages(
  messages: readonly MessageInfo[],
  input: {
    sessionId: string;
    runId: string;
    threadKey: string;
    agentName: string;
    terminalStatus: "failed" | "interrupted";
    reason: string;
  },
): Array<AddMessageInput & { messageId: string }> {
  const answered = new Set(
    messages
      .flatMap((message) => (
        message.role === "tool"
        && message.metadata.run_id === input.runId
        && message.tool_call_id
          ? [message.tool_call_id]
          : []
      )),
  );
  const reason = (
    input.reason.trim()
    || (input.terminalStatus === "failed" ? "未提供失败原因" : "未提供中断原因")
  ).slice(0, 2_000);
  const summary = input.terminalStatus === "failed" ? "工具执行因 Run 失败而终止" : "工具执行被中断";
  const result: Array<AddMessageInput & { messageId: string }> = [];
  for (const message of messages) {
    if (message.role !== "assistant" || message.metadata.run_id !== input.runId) continue;
    const round = resolveRound(message.metadata.round);
    for (const toolCall of message.tool_calls ?? []) {
      if (answered.has(toolCall.id)) continue;
      answered.add(toolCall.id);
      const content = `${summary}：${reason}`;
      result.push({
        messageId: `${input.runId}:tool:${toolCall.id}`,
        sessionId: input.sessionId,
        role: "tool",
        content,
        contentParts: [{ type: "text", text: content }],
        toolCallId: toolCall.id,
        name: toolCall.function.name,
        threadKey: input.threadKey,
        metadata: {
          terminal_tool_result: true,
          terminal_status: input.terminalStatus,
          terminal_reason: reason,
          agent_name: input.agentName,
          run_id: input.runId,
          round: round + 1,
          msg_type: MSG_TYPE.OBSERVATION,
        },
      });
    }
  }
  return result;
}

/** Canonical, idempotent projection for every terminal Run transition. */
export function buildRunTerminalRecords(input: {
  run: TerminalRunIdentity;
  status: TerminalRunStatus;
  reason?: string | null;
  finalMessage: MessageInfo | null;
  closedToolMessages?: readonly MessageInfo[];
}): RuntimeRecordEnvelopeInput[] {
  const { run, status, finalMessage } = input;
  const reason = input.reason?.trim() || null;
  const lineage = run.lineageParentCallId
    ? { lineage: { parent_call_id: run.lineageParentCallId } }
    : {};
  const records: RuntimeRecordEnvelopeInput[] = [];
  if (finalMessage) {
    records.push(terminalEnvelopeRecord(run, `${run.runId}:terminal:stream_output`, {
      type: "stream_output",
      session_id: run.sessionId,
      run_id: run.runId,
      call_id: run.agentCallId,
      agent_id: run.agentName,
      payload: {
        phase: "final",
        content: finalMessage.content,
        content_parts: toAssistantContentParts(finalMessage),
        ...lineage,
      },
    }));
    records.push(terminalEnvelopeRecord(run, `${run.runId}:terminal:state_sync`, {
      type: "state_sync",
      session_id: run.sessionId,
      run_id: run.runId,
      payload: {
        category: "message_saved",
        ref: {
          message_id: finalMessage.id,
          seq: finalMessage.seq,
          role: "assistant",
          content_parts: finalMessage.content_parts,
        },
        ...lineage,
      },
    }));
  }
  const toolStatus = status === "interrupted" ? "interrupted" as const : "failed" as const;
  const toolSummary = status === "interrupted" ? "工具执行被中断" : "工具执行因 Run 失败而终止";
  if (status !== "completed") {
    for (const message of input.closedToolMessages ?? []) {
      if (!message.tool_call_id) continue;
      records.push(terminalEnvelopeRecord(run, `${run.runId}:terminal:tool:${message.tool_call_id}`, {
        type: "tool_result",
        session_id: run.sessionId,
        run_id: run.runId,
        call_id: message.tool_call_id,
        agent_id: run.agentName,
        payload: {
          tool: message.name ?? "unknown",
          phase: "end",
          ok: false,
          status: toolStatus,
          observation: message.content,
          summary: toolSummary,
          lineage: { parent_call_id: run.agentCallId },
        },
      }));
    }
  }
  const agentStatus = status === "completed" ? "succeeded" as const : status;
  records.push(terminalEnvelopeRecord(run, `${run.runId}:terminal:agent_ended`, {
    type: "agent_ended",
    session_id: run.sessionId,
    run_id: run.runId,
    call_id: run.agentCallId,
    agent_id: run.agentName,
    payload: {
      phase: "end",
      display_name: run.agentDisplayName,
      result: (finalMessage?.content ?? reason ?? "").slice(0, 500),
      success: status === "completed",
      status: agentStatus,
      ...lineage,
    },
  }));
  records.push(terminalEnvelopeRecord(run, `${run.runId}:terminal:run_ended`, {
    type: "run_ended",
    session_id: run.sessionId,
    run_id: run.runId,
    payload: {
      status,
      ...(reason ? { reason } : {}),
      ...lineage,
    },
  }));
  return records;
}

function terminalEnvelopeRecord(
  run: TerminalRunIdentity,
  eventId: string,
  event: Envelope,
): RuntimeRecordEnvelopeInput {
  return {
    step: {
      sessionId: run.sessionId,
      runId: run.runId,
      eventId,
      stepType: "protocol.envelope.v1",
      payload: {
        ...event,
        protocol_version: event.protocol_version ?? PROTOCOL_VERSION,
        session_id: run.sessionId,
        run_id: run.runId,
      },
    },
    outbox: {
      sessionId: run.sessionId,
      runId: run.runId,
      eventId,
      eventType: `client.${event.type}`,
      aggregateType: "run",
      aggregateId: run.runId,
      payload: { client_event: event },
    },
  };
}

function toAssistantContentParts(message: MessageInfo): AssistantContentPart[] {
  return message.content_parts.flatMap((part): AssistantContentPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type !== "file_ref") return [];
    return [{
      type: "file_ref",
      file_path: part.file_path,
      presentation: part.presentation,
      ...(part.caption ? { caption: part.caption } : {}),
    }];
  });
}

function resolveRound(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value - 1) : 0;
}
