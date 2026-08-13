import type {
  DurableExecutionClientEventPort,
  DurableExecutionConversationPort,
  DurableExecutionProviderContinuationPort,
  ExecutionRunPersistenceContext,
  ExecutionStorage,
  ExecutionEventPersister,
} from "@ragsystem/backend-core/contracts/execution/execution-storage.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";

export function createPostgresExecutionStorage(input: {
  tenantId: TenantId;
  conversation: Omit<DurableExecutionConversationPort, "updateMessageMetadata"> & {
    updateMessage(input: { sessionId: string; messageId: string; roleFilter: "user"; metadata: Record<string, unknown> }): Promise<boolean>;
  };
  providerContinuations: DurableExecutionProviderContinuationPort;
  clientEvents: DurableExecutionClientEventPort;
  createEventPersister(context: ExecutionRunPersistenceContext): ExecutionEventPersister;
  resultReader: ExecutionStorage["resultReader"];
  agentMailbox?: ExecutionStorage["agentMailbox"];
  commitRunInput: ExecutionStorage["commitRunInput"];
}): ExecutionStorage {
  return {
    tenantId: input.tenantId,
    ...(input.agentMailbox ? { agentMailbox: input.agentMailbox } : {}),
    conversation: {
      ...input.conversation,
      getRecentMessages: input.conversation.getRecentMessages.bind(input.conversation),
      getMessageById: input.conversation.getMessageById.bind(input.conversation),
      getSession: input.conversation.getSession.bind(input.conversation),
      updateSessionMetadata: input.conversation.updateSessionMetadata.bind(input.conversation),
      addMessage: input.conversation.addMessage.bind(input.conversation),
      insertCompressionMessage: input.conversation.insertCompressionMessage.bind(input.conversation),
      updateMessageMetadata: (sessionId, messageId, metadata) => input.conversation.updateMessage({
        sessionId,
        messageId,
        roleFilter: "user",
        metadata,
      }),
    },
    providerContinuations: { getProviderContinuation: (sessionId, messageId) => input.providerContinuations.getProviderContinuation(input.tenantId, sessionId, messageId) },
    resultReader: input.resultReader,
    agentMailbox: input.agentMailbox!,
    commitRunInput: input.commitRunInput,
    createEventPersister: input.createEventPersister,
  };
}
