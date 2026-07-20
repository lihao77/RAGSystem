import type { ConversationStore } from "../../contracts/conversation-store/index.js";
import type { ExecutionStorage } from "../../contracts/execution/execution-storage.js";
import type { RuntimeStorage } from "../../contracts/storage/runtime-storage.js";
import type { TenantId } from "../../identity/types.js";
import { AsyncKernelEventPersister } from "../../services/agent/sdk/async-event-persister.js";
import type { AsyncDurableClientEventPublisher } from "../../services/runtime/event-outbox/async-client-event-publisher.js";

export function createLocalExecutionStorage(input: {
  tenantId: TenantId;
  conversation: ConversationStore;
  runtimeStorage: RuntimeStorage;
  clientEvents: Pick<AsyncDurableClientEventPublisher, "deliver" | "flush">;
  fileHistory?: ConstructorParameters<typeof AsyncKernelEventPersister>[3];
}): ExecutionStorage {
  return {
    kind: "local",
    tenantId: input.tenantId,
    conversation: input.conversation,
    createEventPersister: (context) => new AsyncKernelEventPersister(
      input.runtimeStorage,
      input.clientEvents,
      context,
      input.fileHistory ?? null,
    ),
  };
}
