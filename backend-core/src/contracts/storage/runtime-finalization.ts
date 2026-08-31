import type { AddMessageInput } from "../conversation-store/index.js";
import { MSG_TYPE } from "../message-kinds.js";
import type { MessageInfo } from "../session/session.js";
import { partsToPlainText } from "@ragsystem/agent-protocol";
import type { AssistantContentPart, Envelope } from "@ragsystem/agent-protocol";
import type { RuntimeRecordEnvelopeInput } from "./runtime-storage.js";

export type TerminalAssistantStatus = "failed" | "interrupted";
export type TerminalRunStatus = "completed" | TerminalAssistantStatus;

/** 中断/失败时随 terminal 消息保留的当前轮半成品（思考全文/半截正文）。 */
export interface TerminalSalvage {
  reasoning?: string;
  reasoningComplete?: boolean;
  content?: string;
  round?: number;
}

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
  childAgentId?: string | null;
  agentName: string;
  terminalStatus: TerminalAssistantStatus;
  reason: string;
  messageId?: string;
  salvage?: TerminalSalvage | null;
  metadata?: Record<string, unknown>;
}): AddMessageInput & { messageId: string } {
  const reason = input.reason.trim().slice(0, 2_000)
    || (input.terminalStatus === "failed" ? "未提供失败原因" : "未提供中断原因");
  const displayReason = terminalReasonDisplay(input.terminalStatus, reason);
  const reasonText = input.terminalStatus === "failed"
    ? `本次运行执行失败：${displayReason}`
    : `本次运行已中断，未生成最终答案。原因：${displayReason}`;
  // 中断 salvage：思考（半截或完整）以 thinking part 一等保留；半截正文与中断原因合成 text。
  const salvage = input.salvage ?? null;
  const thinkingPart = salvage?.reasoning?.trim()
    ? [{
      type: "thinking" as const,
      text: salvage.reasoning,
      ...(typeof salvage.round === "number" ? { round: salvage.round } : {}),
      complete: salvage.reasoningComplete === true,
    }]
    : [];
  const partialContent = salvage?.content?.trim() ?? "";
  const contentParts: AddMessageInput["contentParts"] = [
    ...thinkingPart,
    { type: "text", text: partialContent ? `${partialContent}\n\n${reasonText}` : reasonText },
  ];
  const hasSalvage = thinkingPart.length > 0 || Boolean(partialContent);
  return {
    messageId: input.messageId?.trim() || `${input.runId}:terminal`,
    sessionId: input.sessionId,
    role: "assistant",
    contentParts,
    threadKey: input.threadKey,
    childAgentId: input.childAgentId ?? null,
    metadata: {
      agent_name: input.agentName,
      run_id: input.runId,
      agent: input.agentName,
      ...(input.metadata ?? {}),
      msg_type: MSG_TYPE.RUN_TERMINAL,
      terminal_status: input.terminalStatus,
      terminal_reason: reason,
      visible_to_user: true,
      ...(hasSalvage ? { partial: true } : {}),
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
    childAgentId?: string | null;
    agentName: string;
    terminalStatus: "failed" | "interrupted";
    reason: string;
    /** 悬空工具所属 run 段的 boundary 用户消息 id（历史合成分段依据）。 */
    boundaryMessageId?: string | null;
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
    // 无显式 boundary（租约恢复/会话停止等无运行态路径）时，从悬空工具所属
    // assistant 行推导——行上已盖章的 boundary_message_id 即该轮所在段。
    const boundaryMessageId = input.boundaryMessageId
      ?? (typeof message.metadata.boundary_message_id === "string" && message.metadata.boundary_message_id
        ? message.metadata.boundary_message_id
        : null);
    for (const toolCall of message.tool_calls ?? []) {
      if (answered.has(toolCall.id)) continue;
      answered.add(toolCall.id);
      const text = `${summary}：${reason}`;
      result.push({
        messageId: `${input.runId}:tool:${toolCall.id}`,
        sessionId: input.sessionId,
        role: "tool",
        contentParts: [{ type: "text", text }],
        toolCallId: toolCall.id,
        name: toolCall.function.name,
        threadKey: input.threadKey,
        childAgentId: input.childAgentId ?? null,
        metadata: {
          terminal_tool_result: true,
          terminal_status: input.terminalStatus,
          terminal_reason: reason,
          agent_name: input.agentName,
          run_id: input.runId,
          ...(boundaryMessageId ? { boundary_message_id: boundaryMessageId } : {}),
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
  /** 当前 run 段 boundary：终局 envelope 顶层盖章，live 按段精确路由。 */
  boundaryMessageId?: string | null;
}): RuntimeRecordEnvelopeInput[] {
  const { run, status, finalMessage } = input;
  const reason = input.reason?.trim() || null;
  const lineage = run.lineageParentCallId
    ? { lineage: { parent_call_id: run.lineageParentCallId } }
    : {};
  const boundary = input.boundaryMessageId
    ? { boundary_message_id: input.boundaryMessageId }
    : {};
  const records: RuntimeRecordEnvelopeInput[] = [];
  if (finalMessage) {
    records.push(terminalEnvelopeRecord(run, `${run.runId}:terminal:stream_output`, {
      type: "stream_output",
      session_id: run.sessionId,
      run_id: run.runId,
      message_id: finalMessage.id,
      call_id: run.agentCallId,
      agent_id: run.agentName,
      ...boundary,
      payload: {
        phase: "final",
        content: partsToPlainText(finalMessage.content_parts),
        content_parts: toAssistantContentParts(finalMessage),
        ...lineage,
      },
    }));
    records.push(terminalEnvelopeRecord(run, `${run.runId}:terminal:state_sync`, {
      type: "state_sync",
      session_id: run.sessionId,
      run_id: run.runId,
      ...boundary,
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
        // 恢复路径无顶层 boundary 时逐工具回退（补齐行已盖章）。
        ...(input.boundaryMessageId ?? toolBoundaryOf(message)
          ? { boundary_message_id: input.boundaryMessageId ?? toolBoundaryOf(message)! }
          : {}),
        payload: {
          tool: message.name ?? "unknown",
          phase: "end",
          ok: false,
          status: toolStatus,
          observation: partsToPlainText(message.content_parts),
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
    ...boundary,
    // 顶层 timestamp（ISO）供前端执行树定格 agent 工作时长。取终局消息的持久化
    // created_at 而非墙钟：本投影按 eventId 幂等重放，墙钟会使重放 payload 漂移；
    // 消息表 created_at 可能是 SQLite datetime 串，须经 toEnvelopeTimestamp 归一。
    timestamp: toEnvelopeTimestamp(finalMessage?.created_at) ?? new Date().toISOString(),
    payload: {
      phase: "end",
      display_name: run.agentDisplayName,
      result: (finalMessage ? partsToPlainText(finalMessage.content_parts) : (reason ?? "")).slice(0, 500),
      success: status === "completed",
      status: agentStatus,
      ...lineage,
    },
  }));
  records.push(terminalEnvelopeRecord(run, `${run.runId}:terminal:run_ended`, {
    type: "run_ended",
    session_id: run.sessionId,
    run_id: run.runId,
    ...boundary,
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

/** 补齐工具行自带的 boundary（buildTerminalToolMessages 逐工具盖章）。 */
function toolBoundaryOf(message: MessageInfo): string | null {
  const value = message.metadata?.boundary_message_id;
  return typeof value === "string" && value ? value : null;
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

/**
 * 消息表 created_at 可能是 SQLite datetime 串（"YYYY-MM-DD HH:MM:SS"，UTC 落库），而协议
 * envelope 的 timestamp 只接受 int 或 ISO datetime——空格分隔串透传会被响应契约校验拒掉
 * 并整体转成 404（且前端按本地时区解析会错位）。此处归一化为 ISO；已是 ISO 的值原样通过。
 */
export function toEnvelopeTimestamp(createdAt: string | undefined | null): string | undefined {
  if (!createdAt) return undefined;
  if (createdAt.includes("T")) return createdAt;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(createdAt);
  return match ? `${match[1]}T${match[2]}${match[3] ?? ""}Z` : createdAt;
}
