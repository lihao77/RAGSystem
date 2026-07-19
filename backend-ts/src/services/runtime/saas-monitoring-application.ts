import type {
  DeleteDeliveredOutboxInput,
  ListOutboxInput,
  OutboxRow,
  RetryOutboxBatchInput,
  RetryOutboxResult,
} from "../../contracts/conversation-store/index.js";
import type { PaginatedResult } from "../../contracts/common.js";
import type { PostgresOutboxRepository } from "../../adapters/saas/postgres/outbox-repository.js";
import type { MonitoringApplication } from "../../contracts/monitoring-application.js";

export class SaaSMonitoringApplication implements MonitoringApplication {
  constructor(
    private readonly tenantId: string,
    private readonly outbox: Pick<PostgresOutboxRepository, "getOutboxRow" | "listOutbox" | "retryOutbox" | "retryOutboxBatch" | "deleteDeliveredOutbox">,
  ) {}

  listOutbox(input?: ListOutboxInput): Promise<PaginatedResult<OutboxRow>> { return this.outbox.listOutbox(this.tenantId, input); }
  getOutboxRow(id: number): Promise<OutboxRow | null> { return this.outbox.getOutboxRow(this.tenantId, id); }
  retryOutbox(id: number): Promise<boolean> { return this.outbox.retryOutbox(this.tenantId, id); }
  retryOutboxBatch(input?: RetryOutboxBatchInput): Promise<RetryOutboxResult> { return this.outbox.retryOutboxBatch(this.tenantId, input); }
  deleteDeliveredOutbox(input: DeleteDeliveredOutboxInput): Promise<number> { return this.outbox.deleteDeliveredOutbox(this.tenantId, input); }
}
