import type {
  CreatePendingInteractionInput,
  PendingInteractionRecord,
  PendingInteractionStatus,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { RuntimePendingInteractionStorage } from "@ragsystem/backend-core/contracts/storage/runtime-storage.js";
import type { PostgresExecutor } from "./postgres-executor.js";

const columns = `interaction_id, session_id, run_id, root_run_id, tool_call_id,
  batch_id, kind, status, request_payload, resolution_payload, created_at, updated_at,
  responded_at, consumed_at, resume_claim_id, resume_claim_expires_at`;

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
    resume_claim_id: row.resume_claim_id == null ? null : String(row.resume_claim_id),
    resume_claim_expires_at: nullableIso(row.resume_claim_expires_at),
  };
}

export class PostgresPendingInteractionRepository implements RuntimePendingInteractionStorage {
  constructor(private readonly executor: PostgresExecutor) {}

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
          resume_claim_id=CASE WHEN $1='resuming' THEN resume_claim_id ELSE NULL END,
          resume_claim_expires_at=CASE WHEN $1='resuming' THEN resume_claim_expires_at ELSE NULL END,
          updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$4 AND interaction_id=$5${fromClause}`, params);
    return Number(result.rowCount ?? 0) > 0;
  }

  async markPendingBatchResuming(sessionId: string, batchId: string): Promise<number> {
    const result = await this.executor.query(`UPDATE pending_interactions AS candidate
      SET status='resuming', resume_claim_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
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
      SET status='resolved', resume_claim_id=NULL, resume_claim_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$1 AND batch_id=$2 AND status='resuming'`, [sessionId, batchId]);
    return Number(result.rowCount ?? 0);
  }

  async claimPendingBatch(sessionId: string, batchId: string, claimId: string, leaseMs = 120_000): Promise<number> {
    const result = await this.executor.query(`UPDATE pending_interactions AS candidate
      SET status='resuming', resume_claim_id=$3,
          resume_claim_expires_at=CURRENT_TIMESTAMP + ($4::double precision * INTERVAL '1 millisecond'),
          updated_at=CURRENT_TIMESTAMP
      WHERE candidate.session_id=$1 AND candidate.batch_id=$2 AND candidate.status='resolved'
        AND NOT EXISTS (
          SELECT 1 FROM pending_interactions AS unresolved
          WHERE unresolved.session_id=$1 AND unresolved.batch_id=$2
            AND unresolved.status IN ('waiting','suspended')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pending_interactions AS claimed
          WHERE claimed.session_id=$1 AND claimed.batch_id=$2
            AND claimed.status='resuming'
        )`, [sessionId, batchId, claimId, leaseMs]);
    return Number(result.rowCount ?? 0);
  }

  async releasePendingClaim(sessionId: string, rootRunId: string, claimId: string): Promise<number> {
    const result = await this.executor.query(`UPDATE pending_interactions
      SET status='resolved', resume_claim_id=NULL, resume_claim_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$1 AND root_run_id=$2 AND resume_claim_id=$3 AND status='resuming'`,
    [sessionId, rootRunId, claimId]);
    return Number(result.rowCount ?? 0);
  }

  async renewPendingClaim(sessionId: string, rootRunId: string, claimId: string, leaseMs = 120_000): Promise<number> {
    const result = await this.executor.query(`UPDATE pending_interactions
      SET resume_claim_expires_at=CURRENT_TIMESTAMP + ($4::double precision * INTERVAL '1 millisecond'),
          updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$1 AND root_run_id=$2 AND resume_claim_id=$3 AND status='resuming'
        AND resume_claim_expires_at > CURRENT_TIMESTAMP`,
    [sessionId, rootRunId, claimId, leaseMs]);
    return Number(result.rowCount ?? 0);
  }

  async finalizePendingInteractions(
    sessionId: string,
    rootRunId: string,
    status: "completed" | "failed" | "interrupted" | "suspended",
  ): Promise<string[]> {
    const found = await this.executor.query(
      `SELECT ${columns} FROM pending_interactions
       WHERE session_id=$1 AND root_run_id=$2
       ORDER BY created_at, interaction_id FOR UPDATE`,
      [sessionId, rootRunId],
    );
    const records = found.rows.map(interaction);
    for (const record of records) {
      const nextStatus = finalizedInteractionStatus(status, record.status);
      if (!nextStatus || nextStatus === record.status) continue;
      await this.updatePendingInteractionStatus({
        sessionId,
        interactionId: record.interaction_id,
        from: [record.status],
        status: nextStatus,
      });
      record.status = nextStatus;
      if (nextStatus !== "resuming") record.resume_claim_id = null;
    }
    return status === "suspended" ? readyResumeInteractionIds(records) : [];
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
        SET status='consumed', resume_claim_id=NULL, resume_claim_expires_at=NULL,
            consumed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE session_id=$1 AND interaction_id=$2 AND status IN ('resolved','resuming')`,
      [sessionId, String(row.interaction_id)]);
      return Number(updated.rowCount ?? 0) > 0 ? interaction(row) : null;
    });
  }

  async cancelPendingInteractions(sessionId: string): Promise<number> {
    const result = await this.executor.query(`UPDATE pending_interactions
      SET status='cancelled', resume_claim_id=NULL, resume_claim_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$1 AND status IN ('waiting','suspended','resolved','resuming')`, [sessionId]);
    return Number(result.rowCount ?? 0);
  }
}

function finalizedInteractionStatus(
  finalizeStatus: "completed" | "failed" | "interrupted" | "suspended",
  current: PendingInteractionStatus,
): PendingInteractionStatus | null {
  if (finalizeStatus === "suspended") {
    if (current === "waiting") return "suspended";
    if (current === "resuming") return "consumed";
    return null;
  }
  if (finalizeStatus === "completed") {
    if (current === "resolved" || current === "resuming") return "consumed";
    if (current === "waiting" || current === "suspended") return "cancelled";
    return null;
  }
  return current === "waiting" || current === "suspended" || current === "resolved" || current === "resuming"
    ? "cancelled"
    : null;
}

function readyResumeInteractionIds(records: readonly PendingInteractionRecord[]): string[] {
  const batches = new Map<string, PendingInteractionRecord[]>();
  for (const record of records) {
    const batch = batches.get(record.batch_id) ?? [];
    batch.push(record);
    batches.set(record.batch_id, batch);
  }
  return [...batches.values()]
    .filter((batch) => batch.length > 0 && batch.every((record) => record.status === "resolved"))
    .map((batch) => batch[0]!.interaction_id);
}
