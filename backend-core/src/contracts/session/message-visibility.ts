import { MSG_TYPE } from "../message-kinds.js";
import type { MessageInfo } from "./session.js";

export function isAgentConversationMessage(message: Pick<MessageInfo, "metadata">): boolean {
  return message.metadata.agent_message === true;
}

/** Canonical visibility predicate for a root or child participant chat thread. */
export function isParticipantConversationMessageVisible(
  message: Pick<MessageInfo, "role" | "metadata" | "thread_key" | "child_agent_id">,
  threadKey: string,
): boolean {
  if (message.thread_key !== threadKey) return false;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") return false;
  if (message.metadata.react_intermediate === true || message.metadata.hidden === true) return false;
  if (message.metadata.visible_to_user === false && !isAgentConversationMessage(message)) return false;
  if (threadKey === "root") {
    if (message.child_agent_id !== null) return false;
    if (message.metadata.conversation_scope === "child") return false;
    if (message.metadata.msg_type === MSG_TYPE.INTENT || message.metadata.msg_type === MSG_TYPE.OBSERVATION) return false;
  }
  return true;
}

/** Only a human-facing root user turn may anchor a session-wide rollback/retry. */
export function isRootUserRevisionAnchor(
  message: Pick<MessageInfo, "role" | "metadata" | "thread_key" | "child_agent_id">,
): boolean {
  return message.role === "user"
    && !isAgentConversationMessage(message)
    && isParticipantConversationMessageVisible(message, "root");
}
