import type {
  DurableExecutionClientEventPort,
  DurableExecutionConversationPort,
  DurableExecutionProviderContinuationPort,
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
}): ExecutionStorage {
  return { kind: "durable", ...input };
}
