import type {
  CreatePendingInteractionInput,
  IPendingInteractionStore,
  PendingInteractionRecord,
  PendingInteractionStatus,
} from "../../../../contracts/conversation-store/index.js";
import type { ConversationDb } from "./shared/db.js";
import { parseJsonObject, stringifyJson } from "./helpers.js";

interface PendingInteractionRow extends Omit<PendingInteractionRecord, "request_payload" | "resolution_payload"> {
  request_payload: string;
  resolution_payload: string | null;
}

const SELECT_COLUMNS = `interaction_id, session_id, run_id, root_run_id, tool_call_id,
  batch_id, kind, status, request_payload, resolution_payload, created_at, updated_at,
  responded_at, consumed_at, resume_claim_id`;

export class PendingInteractionOps implements IPendingInteractionStore {
  constructor(private readonly db: ConversationDb) {}

  createPendingInteraction(input: CreatePendingInteractionInput): PendingInteractionRecord {
    this.db.prepare(`
      INSERT INTO pending_interactions (
        interaction_id, session_id, run_id, root_run_id, tool_call_id,
        batch_id, kind, status, request_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)
      ON CONFLICT(interaction_id) DO NOTHING
    `).run(
      input.interactionId,
      input.sessionId,
      input.runId,
      input.rootRunId,
      input.toolCallId,
      input.batchId,
      input.kind,
      stringifyJson(input.requestPayload),
    );
    const record = this.getPendingInteraction(input.sessionId, input.interactionId);
    if (!record) throw new Error(`pending interaction insert failed: ${input.interactionId}`);
    return record;
  }

  getPendingInteraction(sessionId: string, interactionId: string): PendingInteractionRecord | null {
    const row = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM pending_interactions WHERE session_id=? AND interaction_id=?`)
      .get(sessionId, interactionId) as PendingInteractionRow | undefined;
    return row ? mapRow(row) : null;
  }

  listPendingInteractions(input: {
    sessionId: string;
    rootRunId?: string | null;
    batchId?: string | null;
    statuses?: PendingInteractionStatus[];
  }): PendingInteractionRecord[] {
    const clauses = ["session_id=?"];
    const params: Array<string> = [input.sessionId];
    if (input.rootRunId) {
      clauses.push("root_run_id=?");
      params.push(input.rootRunId);
    }
    if (input.batchId) {
      clauses.push("batch_id=?");
      params.push(input.batchId);
    }
    if (input.statuses?.length) {
      clauses.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
      params.push(...input.statuses);
    }
    const rows = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM pending_interactions WHERE ${clauses.join(" AND ")} ORDER BY created_at, rowid`)
      .all(...params) as unknown as PendingInteractionRow[];
    return rows.map(mapRow);
  }

  updatePendingInteractionStatus(input: {
    sessionId: string;
    interactionId: string;
    from?: PendingInteractionStatus[];
    status: PendingInteractionStatus;
    resolution?: Record<string, unknown> | null;
  }): boolean {
    const fromClause = input.from?.length ? ` AND status IN (${input.from.map(() => "?").join(",")})` : "";
    const params: Array<string | null> = [
      input.status,
      input.resolution === undefined ? null : stringifyJson(input.resolution ?? {}),
      input.status,
      input.status,
      input.status,
      input.sessionId,
      input.interactionId,
      ...(input.from ?? []),
    ];
    const result = this.db.prepare(`
      UPDATE pending_interactions
      SET status=?,
          resolution_payload=COALESCE(?, resolution_payload),
          responded_at=CASE WHEN ?='resolved' THEN CURRENT_TIMESTAMP ELSE responded_at END,
          consumed_at=CASE WHEN ?='consumed' THEN CURRENT_TIMESTAMP ELSE consumed_at END,
          resume_claim_id=CASE WHEN ?='resuming' THEN resume_claim_id ELSE NULL END,
          updated_at=CURRENT_TIMESTAMP
      WHERE session_id=? AND interaction_id=?${fromClause}
    `).run(...params);
    return Number(result.changes) > 0;
  }

  markPendingBatchResuming(sessionId: string, batchId: string): number {
    const result = this.db.prepare(`
      UPDATE pending_interactions SET status='resuming', updated_at=CURRENT_TIMESTAMP
      WHERE session_id=? AND batch_id=? AND status='resolved'
        AND NOT EXISTS (
          SELECT 1 FROM pending_interactions AS unresolved
          WHERE unresolved.session_id=?
            AND unresolved.batch_id=?
            AND unresolved.status IN ('waiting', 'suspended')
        )
    `).run(sessionId, batchId, sessionId, batchId);
    return Number(result.changes);
  }

  releasePendingBatch(sessionId: string, batchId: string): number {
    const result = this.db.prepare(`
      UPDATE pending_interactions
      SET status='resolved', resume_claim_id=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE session_id=? AND batch_id=? AND status='resuming'
    `).run(sessionId, batchId);
    return Number(result.changes);
  }

  claimPendingBatch(sessionId: string, batchId: string, claimId: string): number {
    const result = this.db.prepare(`
      UPDATE pending_interactions
      SET status='resuming', resume_claim_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE session_id=? AND batch_id=? AND status='resolved'
        AND NOT EXISTS (
          SELECT 1 FROM pending_interactions AS unresolved
          WHERE unresolved.session_id=?
            AND unresolved.batch_id=?
            AND unresolved.status IN ('waiting', 'suspended')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pending_interactions AS claimed
          WHERE claimed.session_id=?
            AND claimed.batch_id=?
            AND claimed.status='resuming'
        )
    `).run(claimId, sessionId, batchId, sessionId, batchId, sessionId, batchId);
    return Number(result.changes);
  }

  releasePendingClaim(sessionId: string, rootRunId: string, claimId: string): number {
    const result = this.db.prepare(`
      UPDATE pending_interactions
      SET status='resolved', resume_claim_id=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE session_id=? AND root_run_id=? AND resume_claim_id=? AND status='resuming'
    `).run(sessionId, rootRunId, claimId);
    return Number(result.changes);
  }

  suspendPendingInteractions(sessionId: string, rootRunId: string): number {
    const result = this.db.prepare(`
      UPDATE pending_interactions SET status='suspended', updated_at=CURRENT_TIMESTAMP
      WHERE session_id=? AND root_run_id=? AND status='waiting'
    `).run(sessionId, rootRunId);
    return Number(result.changes);
  }

  consumePendingResolution(sessionId: string, toolCallId: string): PendingInteractionRecord | null {
    const row = this.db.prepare(`
      SELECT ${SELECT_COLUMNS} FROM pending_interactions
      WHERE session_id=? AND tool_call_id=? AND status IN ('resolved', 'resuming')
      ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get(sessionId, toolCallId) as PendingInteractionRow | undefined;
    if (!row) return null;
    this.updatePendingInteractionStatus({
      sessionId,
      interactionId: row.interaction_id,
      from: ["resolved", "resuming"],
      status: "consumed",
    });
    return mapRow(row);
  }

  cancelPendingInteractions(sessionId: string): number {
    const result = this.db.prepare(`
      UPDATE pending_interactions
      SET status='cancelled', resume_claim_id=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE session_id=? AND status IN ('waiting', 'suspended', 'resolved', 'resuming')
    `).run(sessionId);
    return Number(result.changes);
  }
}

function mapRow(row: PendingInteractionRow): PendingInteractionRecord {
  return {
    ...row,
    kind: row.kind === "user_input" ? "user_input" : "approval",
    status: row.status,
    request_payload: parseJsonObject(row.request_payload),
    resolution_payload: row.resolution_payload ? parseJsonObject(row.resolution_payload) : null,
  };
}
