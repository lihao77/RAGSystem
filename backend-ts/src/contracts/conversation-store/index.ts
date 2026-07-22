/** Shared conversation-store data contracts and asynchronous semantic ports. */
import type { PaginatedResult } from "../common.js";
import type {
  AppendOutboxInput,
  ClaimOutboxInput,
  DeleteDeliveredOutboxInput,
  ListOutboxInput,
  OutboxRow,
  RetryOutboxBatchInput,
  RetryOutboxResult,
} from "./types.js";

export * from "./types.js";

/** Promise-based outbox port used by multi-instance runtimes. */
export interface AsyncOutboxStore {
  appendOutbox(input: AppendOutboxInput): Promise<OutboxRow>;
  claimPendingOutbox(input?: ClaimOutboxInput): Promise<OutboxRow[]>;
  claimOutboxRows(input: {
    ids: readonly number[];
    tenantId?: string;
    lockTimeoutMs?: number;
    now?: Date;
  }): Promise<OutboxRow[]>;
  listOutboxForReplay(input: { tenantId: string; sessionId: string; runIds?: readonly string[] | null; afterSeq?: number; limit?: number }): Promise<OutboxRow[]>;
  markOutboxDelivered(id: number, tenantId: string): Promise<boolean>;
  markOutboxRetrying(id: number, error: string, availableAt: string, tenantId: string): Promise<boolean>;
  markOutboxFailed(id: number, error: string, tenantId: string): Promise<boolean>;
  getOutboxRow(tenantId: string, id: number): Promise<OutboxRow | null>;
  listOutbox(tenantId: string, input?: ListOutboxInput): Promise<PaginatedResult<OutboxRow>>;
  retryOutbox(tenantId: string, id: number, availableAt?: string): Promise<boolean>;
  retryOutboxBatch(tenantId: string, input?: RetryOutboxBatchInput): Promise<RetryOutboxResult>;
  deleteDeliveredOutbox(tenantId: string, input: DeleteDeliveredOutboxInput): Promise<number>;
}
