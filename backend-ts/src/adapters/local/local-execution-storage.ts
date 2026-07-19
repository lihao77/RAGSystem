import type { ConversationStore } from "../../contracts/conversation-store/index.js";
import type { ExecutionStorage } from "../../contracts/execution/execution-storage.js";

export function createLocalExecutionStorage(conversation: ConversationStore): ExecutionStorage {
  return { kind: "local", conversation };
}
