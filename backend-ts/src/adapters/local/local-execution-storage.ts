import type { ConversationStore } from "./sqlite/conversation-store/index.js";
import type { ExecutionStorage } from "../../contracts/execution/execution-storage.js";
import type { RuntimeStorage } from "../../contracts/storage/runtime-storage.js";
import type { TenantId } from "../../identity/types.js";
import { AsyncKernelEventPersister } from "../../services/agent/sdk/async-event-persister.js";
import type { ClientEventPublisherPort } from "../../contracts/runtime/core-runtime-ports.js";

export function createLocalExecutionStorage(input: {
  tenantId: TenantId;
  conversation: ConversationStore;
  runtimeStorage: RuntimeStorage;
  clientEvents: Pick<ClientEventPublisherPort, "prepare" | "deliver" | "flush">;
  fileHistory?: ConstructorParameters<typeof AsyncKernelEventPersister>[3];
}): ExecutionStorage {
  return {
    tenantId: input.tenantId,
    conversation: {
      getRecentMessages: async (sessionId, limit, threadKey) => input.conversation.getRecentMessages(sessionId, limit, threadKey),
      getSession: async (sessionId) => input.conversation.getSession(sessionId),
      updateSessionMetadata: async (sessionId, patch) => input.conversation.updateSessionMetadata(sessionId, patch),
      addMessage: async (message) => input.conversation.addMessage(message),
      insertCompressionMessage: async (message) => input.conversation.insertCompressionMessage(message),
    },
    providerContinuations: {
      getProviderContinuation: async (sessionId, messageId) => input.conversation.getProviderContinuation(sessionId, messageId),
    },
    memoryCandidates: {
      listMemoryCandidates: async (query) => input.conversation.listMemoryCandidates(query),
    },
    resultReader: {
      getRun: async (sessionId, runId) => input.conversation.getRun(sessionId, runId),
      getMessageById: async (sessionId, messageId) => input.conversation.getMessageById(sessionId, messageId),
      listRunSteps: async (query) => input.conversation.listRunSteps(query),
    },
    consumePendingFollowups: async (followups) =>
      (await input.runtimeStorage.operations.consumePendingFollowups(followups)).messages,
    createEventPersister: (context) => new AsyncKernelEventPersister(
      input.runtimeStorage,
      input.clientEvents,
      context,
      input.fileHistory ?? null,
    ),
  };
}
