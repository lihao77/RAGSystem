import type { ClaimOutboxInput, OutboxRow } from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { OutboxDispatchStorePort } from "@ragsystem/backend-core/contracts/runtime/core-runtime-ports.js";
import type { ConversationStore } from "./sqlite/conversation-store/index.js";

/** Promise-only dispatcher adapter over the synchronous Local outbox store. */
export class LocalOutboxStoreAdapter implements OutboxDispatchStorePort {
  constructor(private readonly store: Pick<ConversationStore,
    "claimPendingOutbox" | "markOutboxDelivered" | "markOutboxRetrying" | "markOutboxFailed">) {}

  async claimPendingOutbox(input?: ClaimOutboxInput): Promise<OutboxRow[]> {
    return this.store.claimPendingOutbox(input);
  }

  async markOutboxDelivered(id: number): Promise<boolean> {
    return this.store.markOutboxDelivered(id);
  }

  async markOutboxRetrying(id: number, error: string, availableAt: string): Promise<boolean> {
    return this.store.markOutboxRetrying(id, error, availableAt);
  }

  async markOutboxFailed(id: number, error: string): Promise<boolean> {
    return this.store.markOutboxFailed(id, error);
  }

}
