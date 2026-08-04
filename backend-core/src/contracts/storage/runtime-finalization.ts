import type { AddMessageInput } from "../conversation-store/index.js";
import { MSG_TYPE } from "../message-kinds.js";
import type { MessageInfo } from "../session/session.js";

export function buildInterruptedToolMessages(
  messages: readonly MessageInfo[],
  input: {
    sessionId: string;
    runId: string;
    threadKey: string;
    agentName: string;
  },
): Array<AddMessageInput & { messageId: string }> {
  const answered = new Set(
    messages
      .flatMap((message) => message.role === "tool" && message.tool_call_id ? [message.tool_call_id] : []),
  );
  const result: Array<AddMessageInput & { messageId: string }> = [];
  for (const message of messages) {
    // A new run may begin by resuming a dangling tool call persisted by an
    // older run. Closing only assistant messages owned by the current run
    // leaves that historical call permanently running and causes every later
    // user message to execute it again.
    if (message.role !== "assistant") continue;
    const round = resolveRound(message.metadata.round);
    for (const toolCall of message.tool_calls ?? []) {
      if (answered.has(toolCall.id)) continue;
      answered.add(toolCall.id);
      result.push({
        messageId: `${input.runId}:tool:${toolCall.id}`,
        sessionId: input.sessionId,
        role: "tool",
        content: "工具执行被中断",
        toolCallId: toolCall.id,
        name: toolCall.function.name,
        threadKey: input.threadKey,
        metadata: {
          interrupted: true,
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
