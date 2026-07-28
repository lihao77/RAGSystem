import type {
  DeleteDeliveredOutboxInput,
  ListOutboxInput,
  OutboxRow,
  RetryOutboxBatchInput,
  RetryOutboxResult,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { PaginatedResult } from "@ragsystem/backend-core/contracts/common.js";
import type { MonitoringApplication } from "@ragsystem/backend-core/contracts/application/monitoring-application.js";
import type { MonitoringRepositoryPort } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";

export class SaaSMonitoringApplication implements MonitoringApplication {
  constructor(
    private readonly tenantId: string,
    private readonly outbox: MonitoringRepositoryPort,
  ) {}

  listOutbox(input?: ListOutboxInput): Promise<PaginatedResult<OutboxRow>> { return this.outbox.listOutbox(this.tenantId, input); }
  getOutboxRow(id: number): Promise<OutboxRow | null> { return this.outbox.getOutboxRow(this.tenantId, id); }
  retryOutbox(id: number): Promise<boolean> { return this.outbox.retryOutbox(this.tenantId, id); }
  retryOutboxBatch(input?: RetryOutboxBatchInput): Promise<RetryOutboxResult> { return this.outbox.retryOutboxBatch(this.tenantId, input); }
  deleteDeliveredOutbox(input: DeleteDeliveredOutboxInput): Promise<number> { return this.outbox.deleteDeliveredOutbox(this.tenantId, input); }
}
