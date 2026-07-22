import type {
  DurableExecutionClientEventPort,
  DurableExecutionConversationPort,
  DurableExecutionProviderContinuationPort,
  ExecutionMemoryCandidatePort,
  ExecutionRunPersistenceContext,
  ExecutionStorage,
  ExecutionEventPersister,
} from "../../../contracts/execution/execution-storage.js";
import type { TenantId } from "../../../identity/types.js";

export function createPostgresExecutionStorage(input: {
  tenantId: TenantId;
  conversation: DurableExecutionConversationPort;
  providerContinuations: DurableExecutionProviderContinuationPort;
  clientEvents: DurableExecutionClientEventPort;
  createEventPersister(context: ExecutionRunPersistenceContext): ExecutionEventPersister;
  resultReader: ExecutionStorage["resultReader"];
  memoryCandidates: ExecutionMemoryCandidatePort;
}): ExecutionStorage {
  return {
    tenantId: input.tenantId,
    conversation: input.conversation,
    providerContinuations: { getProviderContinuation: (sessionId, messageId) => input.providerContinuations.getProviderContinuation(input.tenantId, sessionId, messageId) },
    resultReader: input.resultReader,
    memoryCandidates: input.memoryCandidates,
    createEventPersister: input.createEventPersister,
  };
}
