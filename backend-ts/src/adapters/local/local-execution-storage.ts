import type { ConversationStore } from "../../contracts/conversation-store/index.js";
import type { ExecutionStorage } from "../../contracts/execution-storage.js";

export function createLocalExecutionStorage(conversation: ConversationStore): ExecutionStorage {
  return { kind: "local", conversation };
}
