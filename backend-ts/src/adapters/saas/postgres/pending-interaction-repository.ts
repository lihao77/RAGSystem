import type {
  CreatePendingInteractionInput,
  PendingInteractionRecord,
  PendingInteractionStatus,
} from "../../../contracts/conversation-store/index.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

const columns = `interaction_id, session_id, run_id, root_run_id, tool_call_id,
  batch_id, kind, status, request_payload, resolution_payload, created_at, updated_at,
  responded_at, consumed_at`;

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function interaction(row: Record<string, unknown>): PendingInteractionRecord {
  return {
    interaction_id: String(row.interaction_id),
    session_id: String(row.session_id),
    run_id: String(row.run_id),
    root_run_id: String(row.root_run_id),
    tool_call_id: String(row.tool_call_id),
    batch_id: String(row.batch_id),
    kind: row.kind === "user_input" ? "user_input" : "approval",
    status: row.status as PendingInteractionStatus,
    request_payload: jsonObject(row.request_payload),
    resolution_payload: row.resolution_payload == null ? null : jsonObject(row.resolution_payload),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    responded_at: nullableIso(row.responded_at),
    consumed_at: nullableIso(row.consumed_at),
  };
}

export interface AsyncPendingInteractionStore {
  createPendingInteraction(input: CreatePendingInteractionInput): Promise<PendingInteractionRecord>;
  getPendingInteraction(sessionId: string, interactionId: string): Promise<PendingInteractionRecord | null>;
  listPendingInteractions(input: {
    sessionId: string;
    rootRunId?: string | null;
    batchId?: string | null;
    statuses?: PendingInteractionStatus[];
  }): Promise<PendingInteractionRecord[]>;
  updatePendingInteractionStatus(input: {
    sessionId: string;
    interactionId: string;
    from?: PendingInteractionStatus[];
    status: PendingInteractionStatus;
    resolution?: Record<string, unknown> | null;
  }): Promise<boolean>;
  markPendingBatchResuming(sessionId: string, batchId: string): Promise<number>;
  releasePendingBatch(sessionId: string, batchId: string): Promise<number>;
  suspendPendingInteractions(sessionId: string, rootRunId: string): Promise<number>;
  consumePendingResolution(sessionId: string, toolCallId: string): Promise<PendingInteractionRecord | null>;
  cancelPendingInteractions(sessionId: string): Promise<number>;
}

export class PostgresPendingInteractionRepository implements AsyncPendingInteractionStore {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async createPendingInteraction(input: CreatePendingInteractionInput): Promise<PendingInteractionRecord> {
    await this.executor.query(`INSERT INTO pending_interactions (
      interaction_id, session_id, run_id, root_run_id, tool_call_id, batch_id, kind, status, request_payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'waiting',$8::jsonb)
    ON CONFLICT(interaction_id) DO NOTHING`, [
      input.interactionId, input.sessionId, input.runId, input.rootRunId, input.toolCallId,
      input.batchId, input.kind, JSON.stringify(input.requestPayload),
    ]);
    const record = await this.getPendingInteraction(input.sessionId, input.interactionId);
    if (!record) throw new Error(`pending interaction insert failed: ${input.interactionId}`);
    return record;
  }

  async getPendingInteraction(sessionId: string, interactionId: string): Promise<PendingInteractionRecord | null> {
    const result = await this.executor.query(
      `SELECT ${columns} FROM pending_interactions WHERE session_id=$1 AND interaction_id=$2`,
      [sessionId, interactionId],
    );
    return result.rows[0] ? interaction(result.rows[0]) : null;
  }

  async listPendingInteractions(input: {
    sessionId: string;
    rootRunId?: string | null;
    batchId?: string | null;
    statuses?: PendingInteractionStatus[];
  }): Promise<PendingInteractionRecord[]> {
    const clauses = ["session_id=$1"];
    const params: unknown[] = [input.sessionId];
    if (input.rootRunId) {
      params.push(input.rootRunId);
      clauses.push(`root_run_id=$${params.length}`);
    }
    if (input.batchId) {
      params.push(input.batchId);
      clauses.push(`batch_id=$${params.length}`);
    }
    if (input.statuses?.length) {
      params.push(input.statuses);
      clauses.push(`status=ANY($${params.length}::text[])`);
    }
    const result = await this.executor.query(
      `SELECT ${columns} FROM pending_interactions WHERE ${clauses.join(" AND ")} ORDER BY created_at, interaction_id`,
      params,
    );
    return result.rows.map(interaction);
  }

  async updatePendingInteractionStatus(input: {
    sessionId: string;
    interactionId: string;
    from?: PendingInteractionStatus[];
    status: PendingInteractionStatus;
    resolution?: Record<string, unknown> | null;
  }): Promise<boolean> {
    const params: unknown[] = [
      input.status,
      input.resolution === undefined ? null : JSON.stringify(input.resolution ?? {}),
      input.resolution !== undefined,
      input.sessionId,
      input.interactionId,
    ];
    let fromClause = "";
    if (input.from?.length) {
      params.push(input.from);
      fromClause = ` AND status=ANY($${params.length}::text[])`;
    }
    const result = await this.executor.query(`UPDATE pending_interactions
      SET status=$1,
          resolution_payload=CASE WHEN $3::boolean THEN $2::jsonb ELSE resolution_payload END,
          responded_at=CASE WHEN $1='resolved' THEN CURRENT_TIMESTAMP ELSE responded_at END,
          consumed_at=CASE WHEN $1='consumed' THEN CURRENT_TIMESTAMP ELSE consumed_at END,
          updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$4 AND interaction_id=$5${fromClause}`, params);
    return Number(result.rowCount ?? 0) > 0;
  }

  async markPendingBatchResuming(sessionId: string, batchId: string): Promise<number> {
    const result = await this.executor.query(`UPDATE pending_interactions AS candidate
      SET status='resuming', updated_at=CURRENT_TIMESTAMP
      WHERE candidate.session_id=$1 AND candidate.batch_id=$2 AND candidate.status='resolved'
        AND NOT EXISTS (
          SELECT 1 FROM pending_interactions AS unresolved
          WHERE unresolved.session_id=$1 AND unresolved.batch_id=$2
            AND unresolved.status IN ('waiting','suspended')
        )`, [sessionId, batchId]);
    return Number(result.rowCount ?? 0);
  }

  async releasePendingBatch(sessionId: string, batchId: string): Promise<number> {
    const result = await this.executor.query(`UPDATE pending_interactions
      SET status='resolved', updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$1 AND batch_id=$2 AND status='resuming'`, [sessionId, batchId]);
    return Number(result.rowCount ?? 0);
  }

  async suspendPendingInteractions(sessionId: string, rootRunId: string): Promise<number> {
    const result = await this.executor.query(`UPDATE pending_interactions
      SET status='suspended', updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$1 AND root_run_id=$2 AND status='waiting'`, [sessionId, rootRunId]);
    return Number(result.rowCount ?? 0);
  }

  async consumePendingResolution(sessionId: string, toolCallId: string): Promise<PendingInteractionRecord | null> {
    return this.executor.transaction(async (tx) => {
      const found = await tx.query(`SELECT ${columns} FROM pending_interactions
        WHERE session_id=$1 AND tool_call_id=$2 AND status IN ('resolved','resuming')
        ORDER BY updated_at DESC, interaction_id DESC LIMIT 1 FOR UPDATE`, [sessionId, toolCallId]);
      const row = found.rows[0];
      if (!row) return null;
      const updated = await tx.query(`UPDATE pending_interactions
        SET status='consumed', consumed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE session_id=$1 AND interaction_id=$2 AND status IN ('resolved','resuming')`,
      [sessionId, String(row.interaction_id)]);
      return Number(updated.rowCount ?? 0) > 0 ? interaction(row) : null;
    });
  }

  async cancelPendingInteractions(sessionId: string): Promise<number> {
    const result = await this.executor.query(`UPDATE pending_interactions
      SET status='cancelled', updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$1 AND status IN ('waiting','suspended','resolved','resuming')`, [sessionId]);
    return Number(result.rowCount ?? 0);
  }
}
