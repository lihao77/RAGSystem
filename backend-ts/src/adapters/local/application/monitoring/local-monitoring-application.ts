import type { MonitoringApplication } from "../../../../contracts/application/monitoring-application.js";
import type { DeleteDeliveredOutboxInput, IOutboxStore, ListOutboxInput, RetryOutboxBatchInput } from "../../../../contracts/conversation-store/index.js";

/** Async facade over Local's synchronous ConversationStore outbox operations. */
export class LocalMonitoringApplication implements MonitoringApplication {
  constructor(private readonly store: Pick<IOutboxStore, "listOutbox" | "getOutboxRow" | "retryOutbox" | "retryOutboxBatch" | "deleteDeliveredOutbox">) {}
  listOutbox(input?: ListOutboxInput) { return Promise.resolve(this.store.listOutbox(input)); }
  getOutboxRow(id: number) { return Promise.resolve(this.store.getOutboxRow(id)); }
  retryOutbox(id: number) { return Promise.resolve(this.store.retryOutbox(id)); }
  retryOutboxBatch(input?: RetryOutboxBatchInput) { return Promise.resolve(this.store.retryOutboxBatch(input)); }
  deleteDeliveredOutbox(input: DeleteDeliveredOutboxInput) { return Promise.resolve(this.store.deleteDeliveredOutbox(input)); }
}
