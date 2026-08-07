import type { AddMessageInput } from "../conversation-store/index.js";
import { MSG_TYPE } from "../message-kinds.js";
import type { MessageInfo } from "../session/session.js";

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

function resolveRound(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value - 1) : 0;
}
