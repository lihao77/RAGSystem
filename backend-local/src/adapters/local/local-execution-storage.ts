import type { ConversationStore } from "./sqlite/conversation-store/index.js";
import type { ExecutionStorage } from "@ragsystem/backend-core/contracts/execution/execution-storage.js";
import type { RuntimeStorage } from "@ragsystem/backend-core/contracts/storage/runtime-storage.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import { AsyncKernelEventPersister } from "@ragsystem/backend-core/services/agent/sdk/async-event-persister.js";
import type { ClientEventPublisherPort } from "@ragsystem/backend-core/contracts/runtime/core-runtime-ports.js";

export function createLocalExecutionStorage(input: {
  tenantId: TenantId;
  conversation: ConversationStore;
  runtimeStorage: RuntimeStorage;
  clientEvents: Pick<ClientEventPublisherPort, "prepare" | "deliver" | "flush">;
  fileHistory?: ConstructorParameters<typeof AsyncKernelEventPersister>[3];
}): ExecutionStorage {
  return {
    tenantId: input.tenantId,
    agentMailbox: input.conversation.agentMailbox,
    conversation: {
      getRecentMessages: async (sessionId, limit, threadKey) => input.conversation.getRecentMessages(sessionId, limit, threadKey),
      getMessageById: async (sessionId, messageId) => input.conversation.getMessageById(sessionId, messageId),
      getSession: async (sessionId) => input.conversation.getSession(sessionId),
      updateSessionMetadata: async (sessionId, patch) => input.conversation.updateSessionMetadata(sessionId, patch),
      addMessage: async (message) => input.conversation.addMessage(message),
      updateMessageMetadata: async (sessionId, messageId, metadata) => input.conversation.updateMessage({
        sessionId,
        messageId,
        roleFilter: "user",
        metadata,
      }),
      insertCompressionMessage: async (message) => input.conversation.insertCompressionMessage(message),
    },
    providerContinuations: {
      getProviderContinuation: async (sessionId, messageId) => input.conversation.getProviderContinuation(sessionId, messageId),
    },
    resultReader: {
      getRun: async (sessionId, runId) => input.conversation.getRun(sessionId, runId),
      listRuns: async (sessionId, limit, offset) => input.conversation.listRuns(sessionId, limit, offset),
      getMessageById: async (sessionId, messageId) => input.conversation.getMessageById(sessionId, messageId),
      listRunSteps: async (query) => input.conversation.listRunSteps(query),
    },
    commitRunInput: (runInput) => input.runtimeStorage.operations.commitRunInput(runInput),
    createEventPersister: (context) => new AsyncKernelEventPersister(
      input.runtimeStorage,
      input.clientEvents,
      context,
      input.fileHistory ?? null,
    ),
  };
}
