import type {
  DeleteDeliveredOutboxInput,
  ListOutboxInput,
  OutboxRow,
  RetryOutboxBatchInput,
  RetryOutboxResult,
} from "./conversation-store/index.js";
import type { PaginatedResult } from "./common.js";

/** Deployment-neutral outbox operations used by monitoring routes. */
export interface MonitoringApplication {
  listOutbox(input?: ListOutboxInput): Promise<PaginatedResult<OutboxRow>>;
  getOutboxRow(id: number): Promise<OutboxRow | null>;
  retryOutbox(id: number): Promise<boolean>;
  retryOutboxBatch(input?: RetryOutboxBatchInput): Promise<RetryOutboxResult>;
  deleteDeliveredOutbox(input: DeleteDeliveredOutboxInput): Promise<number>;
}
