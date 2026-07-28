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
  conversation: DurableExecutionConversationPort;
  providerContinuations: DurableExecutionProviderContinuationPort;
  clientEvents: DurableExecutionClientEventPort;
  createEventPersister(context: ExecutionRunPersistenceContext): ExecutionEventPersister;
  resultReader: ExecutionStorage["resultReader"];
  consumePendingFollowups: ExecutionStorage["consumePendingFollowups"];
}): ExecutionStorage {
  return {
    tenantId: input.tenantId,
    conversation: input.conversation,
    providerContinuations: { getProviderContinuation: (sessionId, messageId) => input.providerContinuations.getProviderContinuation(input.tenantId, sessionId, messageId) },
    resultReader: input.resultReader,
    consumePendingFollowups: input.consumePendingFollowups,
    createEventPersister: input.createEventPersister,
  };
}
