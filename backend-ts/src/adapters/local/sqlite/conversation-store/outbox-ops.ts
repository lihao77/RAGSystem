import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PaginatedResult } from "../../../../contracts/common.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import {
  ageSeconds,
  normalizeLimit,
  normalizeNonEmptyString,
  normalizeOffset,
  nowIso,
  numericCount,
  uniquePositiveIntegers,
} from "./shared/primitives.js";
import { parseJsonObject, stringifyJson } from "./helpers.js";
import type {
  AppendOutboxInput,
  ClaimOutboxInput,
  DeleteDeliveredOutboxInput,
  EventOutboxErrorSummary,
  EventOutboxStats,
  ListOutboxInput,
  OutboxRow,
  OutboxStatus,
  RetryOutboxBatchInput,
  RetryOutboxResult,
} from "../../../../contracts/conversation-store/index.js";
import { AppendOutboxInputSchema } from "../../../../contracts/conversation-store/types.js";

const OUTBOX_SELECT_COLUMNS = `
  id, event_id, session_id, tenant_id, run_id, session_seq, event_type, aggregate_type,
  aggregate_id, payload, status, attempts, available_at, locked_at, delivered_at,
  last_error, created_at
`;

/** event_outbox + session_event_seq 聚合根操作（迁移自 ConversationStore，方法体零改动）。 */
export class OutboxOps {
  constructor(private readonly db: ConversationDb) {}

  getNextSessionSeq(sessionId: string): number {
    return runInTransaction(this.db, () => this.nextSessionSeqInTransaction(sessionId));
  }

  appendOutbox(input: AppendOutboxInput): OutboxRow {
    const normalized = AppendOutboxInputSchema.parse(input);
    return runInTransaction(this.db, () => this.appendOutboxInTransaction(normalized));
  }

  /** 事务内变体（供 ConversationStoreTransaction facade 调用，故 public）。 */
  appendOutboxInTransaction(input: AppendOutboxInput): OutboxRow {
    const suppliedEventId = input.eventId?.trim();
    if (input.eventId !== undefined && !suppliedEventId) {
      throw new Error("outbox eventId must not be empty");
    }
    const eventId = suppliedEventId ?? randomUUID();
    const existing = this.loadOutboxRowByEventId(eventId);
    if (existing) {
      assertIdempotentOutbox(existing, input, eventId);
      return existing;
    }
    const session = this.db.prepare("SELECT tenant_id FROM sessions WHERE session_id=?").get(input.sessionId) as
      | { tenant_id: string | null }
      | undefined;
    if (!session?.tenant_id) throw new Error(`会话缺少租户归属: ${input.sessionId}`);
    const sessionSeq = input.sessionSeq ?? this.nextSessionSeqInTransaction(input.sessionId);
    const result = this.db
      .prepare(`
        INSERT INTO event_outbox (
          event_id, session_id, tenant_id, run_id, session_seq, event_type, aggregate_type,
          aggregate_id, payload, available_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        input.sessionId,
        session.tenant_id,
        input.runId ?? null,
        sessionSeq,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        stringifyJson(input.payload),
        input.availableAt ?? nowIso(),
      );
    const row = this.loadOutboxRow(Number(result.lastInsertRowid));
    if (!row) {
      throw new Error(`Outbox insert failed: ${eventId}`);
    }
    return row;
  }

  fetchPendingOutbox(limit = 100): OutboxRow[] {
    return this.db
      .prepare(`
        SELECT ${OUTBOX_SELECT_COLUMNS}
        FROM event_outbox
        WHERE status IN ('pending', 'retrying') AND available_at <= ?
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(nowIso(), limit) as unknown as OutboxRow[];
  }

  claimPendingOutbox(input: ClaimOutboxInput = {}): OutboxRow[] {
    const limit = Math.max(1, Math.floor(input.limit ?? 100));
    const now = input.now ?? new Date();
    const lockedAt = now.toISOString();
    const staleBefore = new Date(now.getTime() - Math.max(0, input.lockTimeoutMs ?? 60_000)).toISOString();
    return runInTransaction(this.db, () => {
      const ids = this.db
        .prepare(`
          SELECT id
          FROM event_outbox
          WHERE status IN ('pending', 'retrying')
            AND available_at <= ?
            AND (locked_at IS NULL OR locked_at <= ?)
          ORDER BY id ASC
          LIMIT ?
        `)
        .all(lockedAt, staleBefore, limit) as Array<{ id: number }>;
      if (ids.length === 0) {
        return [];
      }
      const placeholders = ids.map(() => "?").join(", ");
      const idValues = ids.map((row) => row.id);
      this.db
        .prepare(`
          UPDATE event_outbox
          SET locked_at=?
          WHERE id IN (${placeholders})
            AND status IN ('pending', 'retrying')
            AND available_at <= ?
            AND (locked_at IS NULL OR locked_at <= ?)
        `)
        .run(lockedAt, ...idValues, lockedAt, staleBefore);
      return this.db
        .prepare(`
          SELECT ${OUTBOX_SELECT_COLUMNS}
          FROM event_outbox
          WHERE id IN (${placeholders})
            AND locked_at=?
          ORDER BY id ASC
        `)
        .all(...idValues, lockedAt) as unknown as OutboxRow[];
    });
  }

  listOutboxForReplay(input: { sessionId: string; runId?: string | null; runIds?: readonly string[] | null; afterSeq?: number; limit?: number }): OutboxRow[] {
    const limit = input.limit ?? 100;
    const afterSeq = input.afterSeq ?? 0;
    const runIds = input.runIds && input.runIds.length > 0
      ? [...input.runIds]
      : input.runId
        ? [input.runId]
        : null;
    if (runIds && runIds.length > 0) {
      const placeholders = runIds.map(() => "?").join(",");
      return this.db
        .prepare(`
          SELECT ${OUTBOX_SELECT_COLUMNS}
          FROM event_outbox
          WHERE session_id=? AND session_seq > ? AND run_id IN (${placeholders})
          ORDER BY session_seq ASC
          LIMIT ?
        `)
        .all(input.sessionId, afterSeq, ...runIds, limit) as unknown as OutboxRow[];
    }
    return this.db
      .prepare(`
        SELECT ${OUTBOX_SELECT_COLUMNS}
        FROM event_outbox
        WHERE session_id=? AND session_seq > ?
        ORDER BY session_seq ASC
        LIMIT ?
      `)
      .all(input.sessionId, afterSeq, limit) as unknown as OutboxRow[];
  }

  getOutboxRow(id: number): OutboxRow | null {
    return this.loadOutboxRow(id);
  }

  listOutbox(input: ListOutboxInput = {}): PaginatedResult<OutboxRow> {
    const limit = normalizeLimit(input.limit, 100, 500);
    const offset = normalizeOffset(input.offset);
    const filters = buildOutboxFilters(input);
    const where = filters.clauses.length > 0 ? `WHERE ${filters.clauses.join(" AND ")}` : "";
    const total = this.db
      .prepare(`SELECT COUNT(*) AS total FROM event_outbox ${where}`)
      .get(...filters.values) as { total: number } | undefined;
    const items = this.db
      .prepare(`
        SELECT ${OUTBOX_SELECT_COLUMNS}
        FROM event_outbox
        ${where}
        ORDER BY id ASC
        LIMIT ? OFFSET ?
      `)
      .all(...filters.values, limit, offset) as unknown as OutboxRow[];
    const totalCount = numericCount(total?.total);
    return {
      items,
      total: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  markOutboxDelivered(id: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='delivered', delivered_at=?, locked_at=NULL, last_error=NULL
        WHERE id=?
      `)
      .run(nowIso(), id);
    return Number(result.changes) > 0;
  }

  markOutboxRetrying(id: number, error: string, availableAt: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='retrying', attempts=attempts + 1, available_at=?, locked_at=NULL, last_error=?
        WHERE id=?
      `)
      .run(availableAt, error, id);
    return Number(result.changes) > 0;
  }

  markOutboxFailed(id: number, error: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='failed', attempts=attempts + 1, locked_at=NULL, last_error=?
        WHERE id=?
      `)
      .run(error, id);
    return Number(result.changes) > 0;
  }

  retryOutbox(id: number, availableAt = nowIso()): boolean {
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='pending', available_at=?, locked_at=NULL, delivered_at=NULL, last_error=NULL
        WHERE id=? AND status IN ('failed', 'retrying')
      `)
      .run(availableAt, id);
    return Number(result.changes) > 0;
  }

  retryOutboxBatch(input: RetryOutboxBatchInput = {}): RetryOutboxResult {
    const statuses = normalizeOutboxStatuses(input.statuses, ["failed", "retrying"]);
    const availableAt = input.availableAt ?? nowIso();
    const ids = input.ids?.length
      ? uniquePositiveIntegers(input.ids)
      : this.selectOutboxIdsByStatus(statuses, normalizeLimit(input.limit, 100, 500));
    if (ids.length === 0) {
      return { matched: 0, retried: 0, ids: [] };
    }
    const placeholders = ids.map(() => "?").join(", ");
    const statusPlaceholders = statuses.map(() => "?").join(", ");
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='pending', available_at=?, locked_at=NULL, delivered_at=NULL, last_error=NULL
        WHERE id IN (${placeholders}) AND status IN (${statusPlaceholders})
      `)
      .run(availableAt, ...ids, ...statuses);
    const retriedIds = this.db
      .prepare(`
        SELECT id
        FROM event_outbox
        WHERE id IN (${placeholders}) AND status='pending' AND available_at=?
        ORDER BY id ASC
      `)
      .all(...ids, availableAt) as Array<{ id: number }>;
    return {
      matched: ids.length,
      retried: Number(result.changes),
      ids: retriedIds.map((row) => Number(row.id)),
    };
  }

  private selectOutboxIdsByStatus(statuses: OutboxStatus[], limit: number): number[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT id
        FROM event_outbox
        WHERE status IN (${placeholders})
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(...statuses, limit) as Array<{ id: number }>;
    return rows.map((row) => Number(row.id));
  }

  deleteDeliveredOutbox(input: DeleteDeliveredOutboxInput): number {
    const limit = normalizeLimit(input.limit, 100, 10_000);
    const ids = this.db
      .prepare(`
        SELECT id
        FROM event_outbox
        WHERE status='delivered'
          AND COALESCE(delivered_at, created_at) < ?
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(input.before, limit) as Array<{ id: number }>;
    if (ids.length === 0) {
      return 0;
    }
    const placeholders = ids.map(() => "?").join(", ");
    const result = this.db
      .prepare(`DELETE FROM event_outbox WHERE id IN (${placeholders})`)
      .run(...ids.map((row) => row.id));
    return Number(result.changes);
  }

  getOutboxStats(): EventOutboxStats {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status='retrying' THEN 1 ELSE 0 END) AS retrying,
          SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status IN ('pending', 'retrying') AND locked_at IS NOT NULL THEN 1 ELSE 0 END) AS locked,
          SUM(CASE WHEN status IN ('pending', 'retrying') AND locked_at IS NULL AND available_at <= ? THEN 1 ELSE 0 END) AS ready,
          MIN(CASE WHEN status='pending' THEN created_at ELSE NULL END) AS oldest_pending_created_at,
          MIN(CASE WHEN status='retrying' THEN created_at ELSE NULL END) AS oldest_retrying_created_at,
          MIN(CASE WHEN status IN ('pending', 'retrying') THEN created_at ELSE NULL END) AS oldest_pending_or_retrying_created_at,
          MIN(CASE WHEN status='failed' THEN created_at ELSE NULL END) AS oldest_failed_created_at
        FROM event_outbox
      `)
      .get(nowIso()) as {
        total: number | null;
        pending: number | null;
        retrying: number | null;
        delivered: number | null;
        failed: number | null;
        locked: number | null;
        ready: number | null;
        oldest_pending_created_at: string | null;
        oldest_retrying_created_at: string | null;
        oldest_pending_or_retrying_created_at: string | null;
        oldest_failed_created_at: string | null;
      };
    const recentFailedErrors = this.db
      .prepare(`
        SELECT id, event_id, session_id, run_id, event_type, attempts, last_error, created_at
        FROM event_outbox
        WHERE status='failed'
        ORDER BY id DESC
        LIMIT 5
      `)
      .all() as unknown as EventOutboxErrorSummary[];
    return {
      total: numericCount(row.total),
      pending: numericCount(row.pending),
      retrying: numericCount(row.retrying),
      delivered: numericCount(row.delivered),
      failed: numericCount(row.failed),
      locked: numericCount(row.locked),
      ready: numericCount(row.ready),
      oldest_pending_created_at: row.oldest_pending_created_at,
      oldest_pending_age_seconds: ageSeconds(row.oldest_pending_created_at),
      oldest_retrying_created_at: row.oldest_retrying_created_at,
      oldest_retrying_age_seconds: ageSeconds(row.oldest_retrying_created_at),
      oldest_pending_or_retrying_created_at: row.oldest_pending_or_retrying_created_at,
      oldest_pending_or_retrying_age_seconds: ageSeconds(row.oldest_pending_or_retrying_created_at),
      oldest_failed_created_at: row.oldest_failed_created_at,
      oldest_failed_age_seconds: ageSeconds(row.oldest_failed_created_at),
      recent_failed_errors: recentFailedErrors,
    };
  }

  /** 事务内变体（供 ConversationStoreTransaction facade 调用，故 public）。 */
  nextSessionSeqInTransaction(sessionId: string): number {
    this.db
      .prepare(`
        INSERT INTO session_event_seq (session_id, last_seq)
        VALUES (?, 0)
        ON CONFLICT(session_id) DO NOTHING
      `)
      .run(sessionId);
    this.db.prepare("UPDATE session_event_seq SET last_seq=last_seq + 1 WHERE session_id=?").run(sessionId);
    const row = this.db
      .prepare("SELECT last_seq FROM session_event_seq WHERE session_id=?")
      .get(sessionId) as { last_seq: number } | undefined;
    if (!row) {
      throw new Error(`Session event sequence update failed: ${sessionId}`);
    }
    return Number(row.last_seq);
  }

  private loadOutboxRow(id: number): OutboxRow | null {
    const row = this.db
      .prepare(`SELECT ${OUTBOX_SELECT_COLUMNS} FROM event_outbox WHERE id=?`)
      .get(id) as OutboxRow | undefined;
    return row ?? null;
  }

  private loadOutboxRowByEventId(eventId: string): OutboxRow | null {
    const row = this.db
      .prepare(`SELECT ${OUTBOX_SELECT_COLUMNS} FROM event_outbox WHERE event_id=?`)
      .get(eventId) as OutboxRow | undefined;
    return row ?? null;
  }
}

function assertIdempotentOutbox(
  existing: OutboxRow,
  input: AppendOutboxInput,
  eventId: string,
): void {
  const conflicts = existing.session_id !== input.sessionId
    || existing.run_id !== (input.runId ?? null)
    || existing.event_type !== input.eventType
    || existing.aggregate_type !== input.aggregateType
    || existing.aggregate_id !== input.aggregateId
    || !isDeepStrictEqual(parseJsonObject(existing.payload), input.payload)
    || (input.sessionSeq !== undefined && existing.session_seq !== input.sessionSeq)
    || (input.availableAt != null && existing.available_at !== input.availableAt);
  if (conflicts) throw new Error(`outbox eventId conflict: ${eventId}`);
}

function buildOutboxFilters(input: ListOutboxInput): { clauses: string[]; values: Array<string | number> } {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  const statuses = normalizeOutboxStatuses(input.statuses, []);
  if (statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    values.push(...statuses);
  }
  const sessionId = normalizeNonEmptyString(input.sessionId);
  if (sessionId) {
    clauses.push("session_id=?");
    values.push(sessionId);
  }
  const runId = normalizeNonEmptyString(input.runId);
  if (runId) {
    clauses.push("run_id=?");
    values.push(runId);
  }
  return { clauses, values };
}

function normalizeOutboxStatuses(values: OutboxStatus[] | undefined, defaultStatuses: OutboxStatus[]): OutboxStatus[] {
  if (!values || values.length === 0) {
    return [...defaultStatuses];
  }
  const statuses: OutboxStatus[] = [];
  for (const value of values) {
    if (!isOutboxStatus(value)) {
      continue;
    }
    if (!statuses.includes(value)) {
      statuses.push(value);
    }
  }
  return statuses;
}

function isOutboxStatus(value: string): value is OutboxStatus {
  return value === "pending" || value === "retrying" || value === "delivered" || value === "failed";
}
