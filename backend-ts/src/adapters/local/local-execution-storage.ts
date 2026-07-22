import type { ConversationStore } from "../../contracts/conversation-store/index.js";
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
    conversation: input.conversation,
    providerContinuations: { getProviderContinuation: (sessionId, messageId) => input.conversation.getProviderContinuation(sessionId, messageId) },
    memoryCandidates: { listMemoryCandidates: (query) => input.conversation.listMemoryCandidates(query) },
    resultReader: {
      getRun: (sessionId, runId) => input.conversation.getRun(sessionId, runId),
      getMessageById: (sessionId, messageId) => input.conversation.getMessageById(sessionId, messageId),
      listRunSteps: (query) => input.conversation.listRunSteps(query),
    },
    createEventPersister: (context) => new AsyncKernelEventPersister(
      input.runtimeStorage,
      input.clientEvents,
      context,
      input.fileHistory ?? null,
    ),
  };
}
