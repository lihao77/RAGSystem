import type { RunStepInfo } from "@ragsystem/backend-core/contracts/common.js";
import type {
  AddRunStepInput,
  CreatedRun,
  CreateRunInput,
  RunInfo,
  RunStepRecord,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { PostgresExecutor } from "./postgres-executor.js";
import type { AsyncRunStore } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";
export type { AsyncRunStore } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";

const runColumns = `run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
  request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id, agent_display_name,
  lease_root_run_id, thread_key, parent_run_id, parent_call_id,
  child_agent_id, final_message_id, created_at, updated_at`;

interface IdempotentRunStepRow extends Record<string, unknown> {
  id: number | string;
  run_id: string;
  session_id: string;
  event_id: string | null;
  step_order: number | string;
  step_type: string;
}

function textOrNull(value: unknown): string | null { return value == null ? null : String(value); }
function run(row: Record<string, unknown>): RunInfo {
  return {
    run_id: String(row.run_id), session_id: String(row.session_id), tenant_id: String(row.tenant_id ?? ""),
    entrypoint: textOrNull(row.entrypoint), status: String(row.status), task_summary: textOrNull(row.task_summary),
    terminal_reason: textOrNull(row.terminal_reason),
    request_id: textOrNull(row.request_id), user_id: textOrNull(row.user_id), agent_name: textOrNull(row.agent_name),
    agent_call_id: String(row.agent_call_id), lineage_parent_call_id: textOrNull(row.lineage_parent_call_id),
    agent_display_name: String(row.agent_display_name), lease_root_run_id: String(row.lease_root_run_id),
    thread_key: String(row.thread_key ?? "root"), parent_run_id: textOrNull(row.parent_run_id), parent_call_id: textOrNull(row.parent_call_id),
    child_agent_id: textOrNull(row.child_agent_id), final_message_id: textOrNull(row.final_message_id),
    created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

export class PostgresRunRepository implements AsyncRunStore {
  constructor(private readonly executor: PostgresExecutor) {}

  async createRun(input: CreateRunInput & { tenantId: string }): Promise<CreatedRun> {
    const threadKey = input.threadKey?.trim() || "root";
    const status = input.status ?? "running";
    await this.executor.query(`INSERT INTO saas_runs
      (tenant_id, run_id, session_id, entrypoint, status, task_summary, request_id, user_id, agent_name,
       agent_call_id, lineage_parent_call_id, agent_display_name, lease_root_run_id,
       thread_key, parent_run_id, parent_call_id, child_agent_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (tenant_id, run_id) DO NOTHING`, [input.tenantId, input.runId, input.sessionId, input.entrypoint ?? "execute", status,
      input.taskSummary ?? "", input.requestId ?? null, input.userId ?? null, input.agentName ?? null,
      input.agentCallId, input.lineageParentCallId, input.agentDisplayName, input.leaseRootRunId,
      threadKey, input.parentRunId ?? null, input.parentCallId ?? null, input.childAgentId ?? null]);
    return { run_id: input.runId, session_id: input.sessionId, status, thread_key: threadKey,
      parent_run_id: input.parentRunId ?? null, parent_call_id: input.parentCallId ?? null,
      agent_call_id: input.agentCallId, lineage_parent_call_id: input.lineageParentCallId,
      agent_display_name: input.agentDisplayName, lease_root_run_id: input.leaseRootRunId,
      child_agent_id: input.childAgentId ?? null };
  }

  async updateRunStatus(tenantId: string, runId: string, sessionId: string, status: string, finalMessageId: string | null = null, terminalReason: string | null = null): Promise<boolean> {
    const result = await this.executor.query("UPDATE saas_runs SET status=$1, final_message_id=$2, terminal_reason=$3, owner_instance_id=NULL, lease_expires_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$4 AND run_id=$5 AND session_id=$6", [status, finalMessageId, terminalReason, tenantId, runId, sessionId]);
    return Number(result.rowCount ?? 0) > 0;
  }

  async getRun(tenantId: string, sessionId: string, runId: string): Promise<RunInfo | null> {
    const result = await this.executor.query(`SELECT ${runColumns} FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3`, [tenantId, sessionId, runId]);
    return result.rows[0] ? run(result.rows[0]) : null;
  }

  async listRuns(tenantId: string, sessionId: string, limit = 50, offset = 0): Promise<{ items: RunInfo[]; total: number }> {
    const bounded = Math.max(1, Math.min(5000, Math.trunc(limit)));
    const boundedOffset = Math.max(0, Math.trunc(offset));
    const [count, rows] = await Promise.all([
      this.executor.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM saas_runs WHERE tenant_id=$1 AND session_id=$2", [tenantId, sessionId]),
      this.executor.query(`SELECT ${runColumns} FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [tenantId, sessionId, bounded, boundedOffset]),
    ]);
    return { items: rows.rows.map(run), total: Number(count.rows[0]?.count ?? 0) };
  }

  async listParticipantRuns(tenantId: string, sessionId: string, participantId: string, limit: number, offset: number): Promise<{ items: RunInfo[]; total: number }> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const boundedOffset = Math.max(0, Math.trunc(offset));
    const participantWhere = participantId === "root"
      ? "child_agent_id IS NULL AND thread_key='root'"
      : "child_agent_id=$3";
    const identityParams = participantId === "root"
      ? [tenantId, sessionId]
      : [tenantId, sessionId, participantId];
    const limitIndex = identityParams.length + 1;
    const offsetIndex = identityParams.length + 2;
    const [count, rows] = await Promise.all([
      this.executor.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 AND ${participantWhere}`,
        identityParams,
      ),
      this.executor.query(
        `SELECT ${runColumns} FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 AND ${participantWhere} ORDER BY created_at DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        [...identityParams, boundedLimit, boundedOffset],
      ),
    ]);
    return { items: rows.rows.map(run), total: Number(count.rows[0]?.count ?? 0) };
  }

  async interruptSuspendedRuns(tenantId: string, sessionId: string): Promise<RunInfo[]> {
    const result = await this.executor.query(`UPDATE saas_runs
      SET status='interrupted', final_message_id=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE tenant_id=$1 AND session_id=$2 AND status='suspended'
      RETURNING ${runColumns}`, [tenantId, sessionId]);
    return result.rows.map(run);
  }

  async ensureInitialRunMessageBoundary(tenantId: string, sessionId: string, runId: string, messageId: string): Promise<void> {
    await this.executor.query(`
      INSERT INTO saas_run_message_boundaries (
        tenant_id, session_id, run_id, message_id,
        start_after_step_order, boundary_step_order, boundary_kind
      ) VALUES ($1,$2,$3,$4,0,NULL,'carrier')
      ON CONFLICT (tenant_id, session_id, run_id, message_id) DO NOTHING
    `, [tenantId, sessionId, runId, messageId]);
  }

  async addRunStep(input: AddRunStepInput & { tenantId: string }): Promise<RunStepRecord> {
    return this.executor.transaction(async (tx) => {
      const params = [input.tenantId, input.sessionId, input.runId] as const;
      const eventId = normalizeEventId(input.eventId);
      const lockedRun = await tx.query<{ run_id: string }>(
        "SELECT run_id FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 FOR UPDATE",
        params,
      );
      if (!lockedRun.rows[0]) {
        throw new Error(`run not found: ${input.runId}`);
      }
      if (eventId) {
        const existing = await tx.query<IdempotentRunStepRow>(
          `SELECT id, run_id, session_id, event_id, step_order, step_type
           FROM saas_run_steps
           WHERE tenant_id=$1 AND event_id=$2`,
          [input.tenantId, eventId],
        );
        if (existing.rows[0]) {
          assertEventRunScope(existing.rows[0], input.sessionId, input.runId, eventId);
          if (input.boundaryMessageId && input.boundaryKind) {
            await this.upsertRunMessageBoundary(tx, input, Number(existing.rows[0].step_order));
          }
          return toRunStepRecord(existing.rows[0]);
        }
      }
      const next = await tx.query<{ step_order: number | string }>(`
        UPDATE saas_runs
        SET next_step_order=next_step_order+1
        WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3
        RETURNING next_step_order-1 AS step_order
      `, params);
      const order = Number(next.rows[0]?.step_order);
      if (!Number.isSafeInteger(order) || order < 1) throw new Error(`run step order allocation failed: ${input.runId}`);
      const inserted = await tx.query<IdempotentRunStepRow>(
        `INSERT INTO saas_run_steps
          (tenant_id, run_id, session_id, event_id, step_order, step_type, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         RETURNING id, run_id, session_id, event_id, step_order, step_type`,
        [
          input.tenantId,
          input.runId,
          input.sessionId,
          eventId,
          order,
          input.stepType,
          JSON.stringify(input.payload),
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error(`run step insert failed: ${input.runId}`);
      if (input.boundaryMessageId && input.boundaryKind) {
        await this.upsertRunMessageBoundary(tx, input, order);
      }
      return toRunStepRecord(row);
    });
  }

  async getRunMessageBoundary(tenantId: string, sessionId: string, runId: string, messageId: string): Promise<number | null> {
    const result = await this.executor.query<{ boundary_step_order: number | string | null }>(`
      SELECT boundary_step_order FROM saas_run_message_boundaries
      WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND message_id=$4
    `, [tenantId, sessionId, runId, messageId]);
    const value = result.rows[0]?.boundary_step_order;
    return value == null ? null : Number(value);
  }

  async listMessageRunSteps(input: {
    tenantId: string;
    sessionId: string;
    runId: string;
    messageId: string;
    limit: number;
    offset: number;
  }): Promise<{ items: RunStepInfo[]; total: number }> {
    const boundary = await this.executor.query<{
      start_after_step_order: number | string;
      boundary_kind: "carrier" | "terminal";
    }>(`
      SELECT start_after_step_order, boundary_kind
      FROM saas_run_message_boundaries
      WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND message_id=$4
    `, [input.tenantId, input.sessionId, input.runId, input.messageId]);
    const current = boundary.rows[0];
    if (!current || current.boundary_kind === "terminal") return { items: [], total: 0 };
    const startOrder = Number(current.start_after_step_order);
    const end = await this.executor.query<{ end_order: number | string | null }>(`
      SELECT MIN(start_after_step_order) AS end_order
      FROM saas_run_message_boundaries
      WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3
        AND boundary_kind='carrier' AND start_after_step_order>$4
    `, [input.tenantId, input.sessionId, input.runId, startOrder]);
    const endOrder = end.rows[0]?.end_order == null ? Number.MAX_SAFE_INTEGER : Number(end.rows[0].end_order);
    const identityParams = [input.tenantId, input.sessionId, input.runId, startOrder, endOrder] as const;
    const where = `step.tenant_id=$1 AND step.session_id=$2 AND step.run_id=$3
      AND step.step_order>$4 AND step.step_order<$5
      AND step.step_type='protocol.envelope.v1'
      AND COALESCE(step.payload->>'type', '')<>'state_sync'
      AND NOT (
        step.payload->>'type'='stream_output'
        AND COALESCE(step.payload->'payload'->>'phase', '')<>'intent_complete'
      )
      AND NOT EXISTS (
        SELECT 1 FROM saas_run_message_boundaries AS boundary
        WHERE boundary.tenant_id=step.tenant_id AND boundary.session_id=step.session_id
          AND boundary.run_id=step.run_id AND boundary.boundary_kind='carrier'
          AND boundary.boundary_step_order=step.step_order
      )`;
    const boundedLimit = Math.max(1, Math.min(2000, Math.trunc(input.limit)));
    const boundedOffset = Math.max(0, Math.trunc(input.offset));
    const [count, rows] = await Promise.all([
      this.executor.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM saas_run_steps AS step WHERE ${where}`, identityParams),
      this.executor.query<Record<string, unknown>>(`
        SELECT step.id, step.run_id, step.session_id, step.event_id,
               step.step_order, step.step_type, step.payload, step.created_at
        FROM saas_run_steps AS step
        WHERE ${where}
        ORDER BY step.step_order ASC
        LIMIT $6 OFFSET $7
      `, [...identityParams, boundedLimit, boundedOffset]),
    ]);
    return { items: rows.rows.map(mapRunStep), total: Number(count.rows[0]?.total ?? 0) };
  }

  async listRunSteps(input: { tenantId: string; runId?: string | null; sessionId?: string | null; limit?: number; offset?: number }): Promise<RunStepInfo[]> {
    const clauses: string[] = [
      "tenant_id = $1",
      "COALESCE(payload->>'type', '')<>'state_sync'",
      "NOT (payload->>'type'='stream_output' AND COALESCE(payload->'payload'->>'phase', '')<>'intent_complete')",
    ]; const params: unknown[] = [input.tenantId];
    const add = (sql: string, value: unknown): void => { params.push(value); clauses.push(sql.replace("?", `$${params.length}`)); };
    if (input.runId) add("run_id = ?", input.runId);
    if (input.sessionId) add("session_id = ?", input.sessionId);
    params.push(Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 500))));
    const limitParam = params.length;
    params.push(Math.max(0, Math.trunc(input.offset ?? 0)));
    const result = await this.executor.query<Record<string, unknown>>(`SELECT id, run_id, session_id, event_id, step_order, step_type, payload, created_at FROM saas_run_steps WHERE ${clauses.join(" AND ")} ORDER BY step_order ASC LIMIT $${limitParam} OFFSET $${params.length}`, params);
    return result.rows.map(mapRunStep);
  }

  private async upsertRunMessageBoundary(
    tx: PostgresExecutor,
    input: AddRunStepInput & { tenantId: string },
    stepOrder: number,
  ): Promise<void> {
    const existing = await tx.query<{ boundary_step_order: number | string | null }>(`
      SELECT boundary_step_order FROM saas_run_message_boundaries
      WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND message_id=$4
      FOR UPDATE
    `, [input.tenantId, input.sessionId, input.runId, input.boundaryMessageId]);
    const current = existing.rows[0];
    if (current?.boundary_step_order != null && Number(current.boundary_step_order) !== stepOrder) {
      throw new Error(`run message boundary conflict: ${input.boundaryMessageId}`);
    }
    if (current) {
      await tx.query(`
        UPDATE saas_run_message_boundaries SET boundary_step_order=$1, boundary_kind=$2
        WHERE tenant_id=$3 AND session_id=$4 AND run_id=$5 AND message_id=$6
      `, [stepOrder, input.boundaryKind, input.tenantId, input.sessionId, input.runId, input.boundaryMessageId]);
      return;
    }
    const anyBoundary = await tx.query(`
      SELECT 1 FROM saas_run_message_boundaries
      WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 LIMIT 1
    `, [input.tenantId, input.sessionId, input.runId]);
    const startAfter = input.boundaryKind === "carrier" && !anyBoundary.rows[0] ? 0 : stepOrder;
    await tx.query(`
      INSERT INTO saas_run_message_boundaries (
        tenant_id, session_id, run_id, message_id,
        start_after_step_order, boundary_step_order, boundary_kind
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [input.tenantId, input.sessionId, input.runId, input.boundaryMessageId, startAfter, stepOrder, input.boundaryKind]);
  }

  async getTenantRun(tenantId: string, runId: string): Promise<RunInfo | null> {
    const result = await this.executor.query(`SELECT ${runColumns} FROM saas_runs WHERE tenant_id=$1 AND run_id=$2`, [tenantId, runId]);
    return result.rows[0] ? run(result.rows[0]) : null;
  }

  async listTenantRuns(tenantId: string, activeOnly: boolean): Promise<RunInfo[]> {
    const result = await this.executor.query(
      `SELECT ${runColumns} FROM saas_runs WHERE tenant_id=$1${activeOnly ? " AND status='running'" : ""} ORDER BY created_at DESC, run_id DESC`,
      [tenantId],
    );
    return result.rows.map(run);
  }
}

function normalizeEventId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) throw new Error("run step eventId must not be empty");
  return normalized;
}

function assertEventRunScope(
  existing: IdempotentRunStepRow,
  sessionId: string,
  runId: string,
  eventId: string,
): void {
  if (existing.session_id !== sessionId || existing.run_id !== runId) {
    throw new Error(`run step eventId is already owned by another run: ${eventId}`);
  }
}

function toRunStepRecord(row: IdempotentRunStepRow): RunStepRecord {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    event_id: row.event_id == null ? null : String(row.event_id),
    step_order: Number(row.step_order),
    step_type: String(row.step_type),
  };
}

function mapRunStep(row: Record<string, unknown>): RunStepInfo {
  const payload = typeof row.payload === "string"
    ? JSON.parse(row.payload) as Record<string, unknown>
    : (row.payload as Record<string, unknown> | null) ?? {};
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    ...(textOrNull(row.event_id) ? { event_id: textOrNull(row.event_id)! } : {}),
    session_id: String(row.session_id),
    step_order: Number(row.step_order),
    step_type: String(row.step_type),
    payload,
    created_at: new Date(String(row.created_at)).toISOString(),
  };
}
