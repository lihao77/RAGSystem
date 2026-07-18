import { randomUUID } from "node:crypto";
import type {
  AppendOutboxInput,
  ClaimOutboxInput,
  OutboxRow,
} from "../../../contracts/conversation-store/index.js";
import { AppendOutboxInputSchema } from "../../../contracts/conversation-store/types.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

export interface AsyncOutboxStore {
  appendOutbox(input: AppendOutboxInput): Promise<OutboxRow>;
  claimPendingOutbox(input?: ClaimOutboxInput): Promise<OutboxRow[]>;
  markOutboxDelivered(id: number): Promise<boolean>;
  markOutboxRetrying(id: number, error: string, availableAt: string): Promise<boolean>;
  markOutboxFailed(id: number, error: string): Promise<boolean>;
}

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
    const now = input.now ?? new Date();
    const stale = new Date(now.getTime() - Math.max(0, input.lockTimeoutMs ?? 60_000));
    return this.executor.transaction(async (tx) => {
      const claimed = await tx.query(`WITH picked AS (SELECT id FROM event_outbox WHERE status IN ('pending','retrying') AND available_at <= $1 AND (locked_at IS NULL OR locked_at <= $2) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $3) UPDATE event_outbox e SET locked_at=$1 FROM picked WHERE e.id=picked.id RETURNING ${SELECT}`, [now.toISOString(), stale.toISOString(), limit]);
      return claimed.rows.map(row);
    });
  }

  async markOutboxDelivered(id: number): Promise<boolean> { const r = await this.executor.query("UPDATE event_outbox SET status='delivered',delivered_at=CURRENT_TIMESTAMP,locked_at=NULL WHERE id=$1 AND status IN ('pending','retrying')", [id]); return Number(r.rowCount ?? 0) > 0; }
  async markOutboxRetrying(id: number, error: string, availableAt: string): Promise<boolean> { const r = await this.executor.query("UPDATE event_outbox SET status='retrying',attempts=attempts+1,last_error=$2,available_at=$3::timestamptz,locked_at=NULL WHERE id=$1 AND status IN ('pending','retrying')", [id, error, availableAt]); return Number(r.rowCount ?? 0) > 0; }
  async markOutboxFailed(id: number, error: string): Promise<boolean> { const r = await this.executor.query("UPDATE event_outbox SET status='failed',attempts=attempts+1,last_error=$2,locked_at=NULL WHERE id=$1 AND status IN ('pending','retrying')", [id, error]); return Number(r.rowCount ?? 0) > 0; }
}
