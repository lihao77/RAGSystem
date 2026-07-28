import { randomUUID } from "node:crypto";
import type {
  AppendOutboxInput,
  AsyncOutboxStore,
  ClaimOutboxInput,
  DeleteDeliveredOutboxInput,
  ListOutboxInput,
  OutboxRow,
  RetryOutboxBatchInput,
  RetryOutboxResult,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { PaginatedResult } from "@ragsystem/backend-core/contracts/common.js";
import { AppendOutboxInputSchema } from "@ragsystem/backend-core/contracts/conversation-store/types.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

const iso = (v: unknown): string => new Date(String(v)).toISOString();
const row = (r: Record<string, unknown>): OutboxRow => ({
  id: Number(r.id), event_id: String(r.event_id), session_id: String(r.session_id), tenant_id: String(r.tenant_id),
  run_id: r.run_id == null ? null : String(r.run_id), session_seq: Number(r.session_seq), event_type: String(r.event_type),
  aggregate_type: String(r.aggregate_type), aggregate_id: String(r.aggregate_id),
  payload: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload ?? {}),
  status: r.status as OutboxRow["status"], attempts: Number(r.attempts), available_at: r.available_at == null ? null : iso(r.available_at),
  locked_at: r.locked_at == null ? null : iso(r.locked_at), delivered_at: r.delivered_at == null ? null : iso(r.delivered_at),
  last_error: r.last_error == null ? null : String(r.last_error), created_at: iso(r.created_at),
});

const SELECT = `id,event_id,session_id,tenant_id,run_id,session_seq,event_type,aggregate_type,aggregate_id,payload,status,attempts,available_at,locked_at,delivered_at,last_error,created_at`;
const UPDATE_RETURNING = SELECT.split(",").map((column) => `e.${column}`).join(",");

export class PostgresOutboxRepository implements AsyncOutboxStore {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async appendOutbox(input: AppendOutboxInput): Promise<OutboxRow> {
    const normalized = AppendOutboxInputSchema.parse(input);
    return this.executor.transaction(async (tx) => {
      const eventId = normalized.eventId ?? randomUUID();
      const existing = await tx.query(`SELECT ${SELECT} FROM event_outbox WHERE event_id=$1`, [eventId]);
      if (existing.rows[0]) return row(existing.rows[0]);
      const session = await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM conversation_sessions WHERE session_id=$1", [normalized.sessionId]);
      const tenantId = session.rows[0]?.tenant_id;
      if (!tenantId) throw new Error(`session missing tenant: ${normalized.sessionId}`);
      const seq = normalized.sessionSeq ?? Number((await tx.query("INSERT INTO session_event_seq(session_id,next_seq) VALUES($1,2) ON CONFLICT(session_id) DO UPDATE SET next_seq=session_event_seq.next_seq+1 RETURNING next_seq-1 AS seq", [normalized.sessionId])).rows[0]?.seq ?? 1);
      if (normalized.sessionSeq != null) {
        await tx.query("INSERT INTO session_event_seq(session_id,next_seq) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET next_seq=GREATEST(session_event_seq.next_seq,EXCLUDED.next_seq)", [normalized.sessionId, seq + 1]);
      }
      const inserted = await tx.query(`INSERT INTO event_outbox(event_id,session_id,tenant_id,run_id,session_seq,event_type,aggregate_type,aggregate_id,payload,available_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,COALESCE($10::timestamptz,CURRENT_TIMESTAMP)) ON CONFLICT(session_id,session_seq) DO NOTHING RETURNING ${SELECT}`,
        [eventId, normalized.sessionId, tenantId, normalized.runId ?? null, seq, normalized.eventType, normalized.aggregateType, normalized.aggregateId, JSON.stringify(normalized.payload), normalized.availableAt ?? null]);
      if (inserted.rows[0]) return row(inserted.rows[0]);
      const duplicate = await tx.query(`SELECT ${SELECT} FROM event_outbox WHERE session_id=$1 AND session_seq=$2`, [normalized.sessionId, seq]);
      if (!duplicate.rows[0]) throw new Error(`outbox insert failed: ${eventId}`);
      return row(duplicate.rows[0]);
    });
  }

  async claimPendingOutbox(input: ClaimOutboxInput = {}): Promise<OutboxRow[]> {
    const limit = Math.max(1, Math.floor(input.limit ?? 100));
    const now = input.now?.toISOString() ?? null;
    const lockTimeoutMs = Math.max(0, input.lockTimeoutMs ?? 60_000);
    return this.executor.transaction(async (tx) => {
      const params: unknown[] = [now, lockTimeoutMs];
      const tenantFilter = input.tenantId ? ` AND tenant_id=$${params.push(input.tenantId)}` : "";
      const limitParam = params.push(limit);
      const claimed = await tx.query(`WITH picked AS (SELECT id FROM event_outbox WHERE status IN ('pending','retrying') AND available_at <= COALESCE($1::timestamptz,CURRENT_TIMESTAMP) AND (locked_at IS NULL OR locked_at <= COALESCE($1::timestamptz,CURRENT_TIMESTAMP)-($2::double precision*INTERVAL '1 millisecond'))${tenantFilter} ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $${limitParam}) UPDATE event_outbox e SET locked_at=COALESCE($1::timestamptz,CURRENT_TIMESTAMP) FROM picked WHERE e.id=picked.id RETURNING ${UPDATE_RETURNING}`, params);
      return claimed.rows.map(row);
    });
  }

  async claimOutboxRows(input: {
    ids: readonly number[];
    tenantId?: string;
    lockTimeoutMs?: number;
    now?: Date;
  }): Promise<OutboxRow[]> {
    const ids = [...new Set(input.ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (ids.length === 0) return [];
    const now = input.now?.toISOString() ?? null;
    const lockTimeoutMs = Math.max(0, input.lockTimeoutMs ?? 60_000);
    return this.executor.transaction(async (tx) => {
      const params: unknown[] = [ids, now, lockTimeoutMs];
      const tenantFilter = input.tenantId ? ` AND tenant_id=$${params.push(input.tenantId)}` : "";
      const claimed = await tx.query(
        `WITH picked AS (
          SELECT id FROM event_outbox
          WHERE id=ANY($1::bigint[])
            AND status IN ('pending','retrying')
            AND available_at <= COALESCE($2::timestamptz,CURRENT_TIMESTAMP)
            AND (locked_at IS NULL OR locked_at <= COALESCE($2::timestamptz,CURRENT_TIMESTAMP)-($3::double precision*INTERVAL '1 millisecond'))${tenantFilter}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE event_outbox e SET locked_at=COALESCE($2::timestamptz,CURRENT_TIMESTAMP)
        FROM picked WHERE e.id=picked.id
        RETURNING ${UPDATE_RETURNING}`,
        params,
      );
      return claimed.rows.map(row);
    });
  }

  async listOutboxForReplay(input: { tenantId: string; sessionId: string; runIds?: readonly string[] | null; afterSeq?: number; limit?: number }): Promise<OutboxRow[]> {
    const clauses = ["tenant_id=$1", "session_id=$2", "event_type LIKE 'client.%'"];
    const params: unknown[] = [input.tenantId, input.sessionId];
    if (input.runIds) {
      if (input.runIds.length === 0) return [];
      params.push(input.runIds);
      clauses.push(`run_id=ANY($${params.length}::text[])`);
    }
    if (input.afterSeq !== undefined) {
      params.push(input.afterSeq);
      clauses.push(`session_seq>$${params.length}`);
    }
    params.push(Math.max(1, Math.min(500, Math.trunc(input.limit ?? 500))));
    const result = await this.executor.query(
      `SELECT ${SELECT} FROM event_outbox WHERE ${clauses.join(" AND ")} ORDER BY session_seq ASC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(row);
  }

  async markOutboxDelivered(id: number, tenantId: string): Promise<boolean> {
    const r = await this.executor.query(
      "UPDATE event_outbox SET status='delivered',delivered_at=CURRENT_TIMESTAMP,locked_at=NULL WHERE id=$1 AND tenant_id=$2 AND status IN ('pending','retrying')",
      [id, tenantId],
    );
    return Number(r.rowCount ?? 0) > 0;
  }
  async markOutboxRetrying(id: number, error: string, availableAt: string, tenantId: string): Promise<boolean> {
    const r = await this.executor.query(
      "UPDATE event_outbox SET status='retrying',attempts=attempts+1,last_error=$2,available_at=$3::timestamptz,locked_at=NULL WHERE id=$1 AND tenant_id=$4 AND status IN ('pending','retrying')",
      [id, error, availableAt, tenantId],
    );
    return Number(r.rowCount ?? 0) > 0;
  }
  async markOutboxFailed(id: number, error: string, tenantId: string): Promise<boolean> {
    const r = await this.executor.query(
      "UPDATE event_outbox SET status='failed',attempts=attempts+1,last_error=$2,locked_at=NULL WHERE id=$1 AND tenant_id=$3 AND status IN ('pending','retrying')",
      [id, error, tenantId],
    );
    return Number(r.rowCount ?? 0) > 0;
  }

  async getOutboxRow(tenantId: string, id: number): Promise<OutboxRow | null> {
    const result = await this.executor.query(`SELECT ${SELECT} FROM event_outbox WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return result.rows[0] ? row(result.rows[0]) : null;
  }

  async listOutbox(tenantId: string, input: ListOutboxInput = {}): Promise<PaginatedResult<OutboxRow>> {
    const clauses = ["tenant_id=$1"];
    const params: unknown[] = [tenantId];
    if (input.statuses?.length) { params.push(input.statuses); clauses.push(`status=ANY($${params.length}::text[])`); }
    if (input.sessionId) { params.push(input.sessionId); clauses.push(`session_id=$${params.length}`); }
    if (input.runId) { params.push(input.runId); clauses.push(`run_id=$${params.length}`); }
    const where = clauses.join(" AND ");
    const count = await this.executor.query(`SELECT COUNT(*) AS total FROM event_outbox WHERE ${where}`, params);
    const total = Number(count.rows[0]?.total ?? 0);
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    params.push(limit, offset);
    const result = await this.executor.query(`SELECT ${SELECT} FROM event_outbox WHERE ${where} ORDER BY id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: result.rows.map(row), total, limit, offset, has_more: offset + limit < total };
  }

  async retryOutbox(tenantId: string, id: number, availableAt = new Date().toISOString()): Promise<boolean> {
    const result = await this.executor.query("UPDATE event_outbox SET status='pending',available_at=$3::timestamptz,locked_at=NULL,delivered_at=NULL,last_error=NULL WHERE tenant_id=$1 AND id=$2 AND status IN ('failed','retrying')", [tenantId, id, availableAt]);
    return Number(result.rowCount ?? 0) > 0;
  }

  async retryOutboxBatch(tenantId: string, input: RetryOutboxBatchInput = {}): Promise<RetryOutboxResult> {
    const statuses = input.statuses?.length ? input.statuses.filter((status) => status === "failed" || status === "retrying") : ["failed", "retrying"];
    if (!statuses.length) return { matched: 0, retried: 0, ids: [] };
    const clauses = ["tenant_id=$1", "status=ANY($2::text[])"];
    const params: unknown[] = [tenantId, statuses];
    if (input.ids) {
      if (!input.ids.length) return { matched: 0, retried: 0, ids: [] };
      params.push(input.ids);
      clauses.push(`id=ANY($${params.length}::bigint[])`);
    }
    params.push(Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100))));
    const limitParam = params.length;
    params.push(input.availableAt ?? new Date().toISOString());
    const availableParam = params.length;
    const result = await this.executor.query(
      `WITH picked AS (SELECT id FROM event_outbox WHERE ${clauses.join(" AND ")} ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $${limitParam}) UPDATE event_outbox e SET status='pending',available_at=$${availableParam}::timestamptz,locked_at=NULL,delivered_at=NULL,last_error=NULL FROM picked WHERE e.id=picked.id RETURNING e.id`,
      params,
    );
    const ids = result.rows.map((item) => Number(item.id));
    return { matched: ids.length, retried: ids.length, ids };
  }

  async deleteDeliveredOutbox(tenantId: string, input: DeleteDeliveredOutboxInput): Promise<number> {
    const result = await this.executor.query(
      "WITH picked AS (SELECT id FROM event_outbox WHERE tenant_id=$1 AND status='delivered' AND COALESCE(delivered_at,created_at)<$2::timestamptz ORDER BY id LIMIT $3) DELETE FROM event_outbox e USING picked WHERE e.id=picked.id",
      [tenantId, input.before, Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 1000)))],
    );
    return Number(result.rowCount ?? 0);
  }
}
