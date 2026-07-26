import { MSG_TYPE } from "../message-kinds.js";
import type { MessageInfo } from "./session.js";

/** One canonical definition used by every conversation-store projector. */
export function isSessionListVisibleMessage(message: Pick<
  MessageInfo,
  "role" | "metadata" | "thread_key" | "child_agent_id"
>): boolean {
  if (message.thread_key !== "root" || message.child_agent_id !== null) return false;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") return false;
  if (message.metadata.react_intermediate === true) return false;
  if (message.metadata.visible_to_user === false) return false;
  if (message.metadata.conversation_scope === "child") return false;
  if (message.metadata.msg_type === MSG_TYPE.INTENT || message.metadata.msg_type === MSG_TYPE.OBSERVATION) return false;
  return true;
}
