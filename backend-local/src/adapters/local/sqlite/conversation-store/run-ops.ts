import type { RunStepInfo } from "@ragsystem/backend-core/contracts/common.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { parseJsonObject, stringifyJson } from "./helpers.js";
import { rowToRun, rowToRunStep } from "./mappers.js";
import type {
  AddRunStepInput,
  CreatedRun,
  CreateRunInput,
  RunInfo,
  RunStepRecord,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { RunRow, RunStepRow } from "./types.js";

const RUN_STEP_SELECT_COLUMNS = "id, run_id, session_id, event_id, step_order, step_type, payload, created_at";
const ALIASED_RUN_STEP_SELECT_COLUMNS = "step.id, step.run_id, step.session_id, step.event_id, step.step_order, step.step_type, step.payload, step.created_at";

interface IdempotentRunStepRow {
  id: number;
  run_id: string;
  session_id: string;
  event_id: string;
  step_order: number;
  step_type: string;
}

interface IdempotentRunStepDbRow extends IdempotentRunStepRow {
  payload: string;
}

/** runs + run_steps 聚合根操作（迁移自 ConversationStore，方法体零改动）。 */
export class RunOps {
  constructor(private readonly db: ConversationDb) {}

  createRun(input: CreateRunInput): CreatedRun {
    const threadKey = input.threadKey?.trim() || "root";
    const status = input.status ?? "running";
    this.db
      .prepare(
        `
          INSERT INTO runs (
            run_id, session_id, tenant_id, entrypoint, status, task_summary,
            request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
            agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id, child_agent_id
          )
          SELECT ?, session_id, tenant_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM sessions
          WHERE session_id=?
        `,
      )
      .run(
        input.runId,
        input.entrypoint ?? "execute",
        status,
        input.taskSummary ?? "",
        input.requestId ?? null,
        input.userId ?? null,
        input.agentName ?? null,
        input.agentCallId,
        input.lineageParentCallId,
        input.agentDisplayName,
        input.leaseRootRunId,
        threadKey,
        input.parentRunId ?? null,
        input.parentCallId ?? null,
        input.childAgentId ?? null,
        input.sessionId,
      );
    return {
      run_id: input.runId,
      session_id: input.sessionId,
      status,
      thread_key: threadKey,
      parent_run_id: input.parentRunId ?? null,
      parent_call_id: input.parentCallId ?? null,
      agent_call_id: input.agentCallId,
      lineage_parent_call_id: input.lineageParentCallId,
      agent_display_name: input.agentDisplayName,
      lease_root_run_id: input.leaseRootRunId,
      child_agent_id: input.childAgentId ?? null,
    };
  }

  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId: string | null = null, terminalReason: string | null = null): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE runs
          SET status=?, final_message_id=?, terminal_reason=?, updated_at=CURRENT_TIMESTAMP
          WHERE run_id=? AND session_id=?
        `,
      )
      .run(status, finalMessageId, terminalReason, runId, sessionId);
    return Number(result.changes) > 0;
  }

  getRun(sessionId: string, runId: string): RunInfo | null {
    const row = this.db
      .prepare(
        `
          SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                 request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                 agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                 child_agent_id, final_message_id, created_at, updated_at
          FROM runs
          WHERE session_id=? AND run_id=?
        `,
      )
      .get(sessionId, runId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(sessionId: string, limit = 50, offset = 0): { items: RunInfo[]; total: number } {
    const totalRow = this.db
      .prepare("SELECT COUNT(1) AS cnt FROM runs WHERE session_id=?")
      .get(sessionId) as { cnt: number };
    const rows = this.db
      .prepare(
        `
          SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                 request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                 agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                 child_agent_id, final_message_id, created_at, updated_at
          FROM runs
          WHERE session_id=?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(sessionId, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset))) as unknown as RunRow[];
    const items = rows.map(rowToRun);
    return { items, total: totalRow.cnt };
  }

  listParticipantRuns(sessionId: string, participantId: string, limit: number, offset: number): { items: RunInfo[]; total: number } {
    const participantWhere = participantId === "root"
      ? "child_agent_id IS NULL AND thread_key='root'"
      : "child_agent_id=?";
    const identityParams = participantId === "root" ? [sessionId] : [sessionId, participantId];
    const totalRow = this.db
      .prepare(`SELECT COUNT(1) AS cnt FROM runs WHERE session_id=? AND ${participantWhere}`)
      .get(...identityParams) as { cnt: number };
    const rows = this.db
      .prepare(
        `
          SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                 request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                 agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                 child_agent_id, final_message_id, created_at, updated_at
          FROM runs
          WHERE session_id=? AND ${participantWhere}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...identityParams, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset))) as unknown as RunRow[];
    return { items: rows.map(rowToRun), total: totalRow.cnt };
  }

  listActiveRootRuns(sessionId: string, limit = 2): RunInfo[] {
    const rows = this.db.prepare(`
      SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
             request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
             agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
             child_agent_id, final_message_id, created_at, updated_at
      FROM runs
      WHERE session_id=? AND parent_run_id IS NULL AND child_agent_id IS NULL
        AND status IN ('running', 'suspended')
      ORDER BY updated_at DESC, created_at DESC, run_id DESC
      LIMIT ?
    `).all(sessionId, limit) as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  getLatestTerminalRootRun(sessionId: string): RunInfo | null {
    const row = this.db.prepare(`
      SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
             request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
             agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
             child_agent_id, final_message_id, created_at, updated_at
      FROM runs
      WHERE session_id=? AND parent_run_id IS NULL AND child_agent_id IS NULL
        AND status IN ('completed', 'failed', 'interrupted')
      ORDER BY updated_at DESC, created_at DESC, run_id DESC
      LIMIT 1
    `).get(sessionId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  addRunStep(input: AddRunStepInput): RunStepRecord {
    return runInTransaction(this.db, () => this.addRunStepInTransaction(input));
  }

  ensureInitialRunMessageBoundary(sessionId: string, runId: string, messageId: string): void {
    this.db.prepare(`
      INSERT INTO run_message_boundaries (
        session_id, run_id, message_id, start_after_step_order, boundary_step_order, boundary_kind
      ) VALUES (?, ?, ?, 0, NULL, 'carrier')
      ON CONFLICT(session_id, run_id, message_id) DO NOTHING
    `).run(sessionId, runId, messageId);
  }

  /** 事务内变体（供 ConversationStoreTransaction facade 调用，故 public）。 */
  addRunStepInTransaction(input: AddRunStepInput): RunStepRecord {
    const eventId = normalizeEventId(input.eventId);
    if (eventId) {
      const existing = this.db
        .prepare(`
          SELECT id, run_id, session_id, event_id, step_order, step_type
          FROM run_steps
          WHERE event_id=?
        `)
        .get(eventId) as IdempotentRunStepRow | undefined;
      if (existing) {
        assertEventRunScope(existing, input.sessionId, input.runId, eventId);
        if (input.boundaryMessageId && input.boundaryKind) {
          this.upsertRunMessageBoundary(
            input.sessionId,
            input.runId,
            input.boundaryMessageId,
            Number(existing.step_order),
            input.boundaryKind,
          );
        }
        return toRunStepRecord(existing);
      }
    }
    const orderRow = this.db.prepare(`
      UPDATE runs
      SET next_step_order=next_step_order+1
      WHERE session_id=? AND run_id=?
      RETURNING next_step_order-1 AS step_order
    `).get(input.sessionId, input.runId) as { step_order: number } | undefined;
    if (!orderRow) throw new Error(`run not found: ${input.runId}`);
    const stepOrder = Number(orderRow.step_order);
    const result = this.db
      .prepare(`
        INSERT INTO run_steps (run_id, session_id, event_id, step_order, step_type, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.runId,
        input.sessionId,
        eventId,
        stepOrder,
        input.stepType,
        stringifyJson(input.payload),
      );
    if (input.boundaryMessageId && input.boundaryKind) {
      this.upsertRunMessageBoundary(
        input.sessionId,
        input.runId,
        input.boundaryMessageId,
        stepOrder,
        input.boundaryKind,
      );
    }
    return {
      id: Number(result.lastInsertRowid),
      run_id: input.runId,
      event_id: eventId,
      step_order: stepOrder,
      step_type: input.stepType,
    };
  }

  getRunMessageBoundary(sessionId: string, runId: string, messageId: string): number | null {
    const row = this.db.prepare(`
      SELECT boundary_step_order
      FROM run_message_boundaries
      WHERE session_id=? AND run_id=? AND message_id=?
    `).get(sessionId, runId, messageId) as { boundary_step_order: number | null } | undefined;
    return row?.boundary_step_order ?? null;
  }

  listMessageRunSteps(input: {
    sessionId: string;
    runId: string;
    messageId: string;
    limit: number;
    offset: number;
  }): { items: RunStepInfo[]; total: number } {
    const boundary = this.db.prepare(`
      SELECT start_after_step_order, boundary_kind
      FROM run_message_boundaries
      WHERE session_id=? AND run_id=? AND message_id=?
    `).get(input.sessionId, input.runId, input.messageId) as {
      start_after_step_order: number;
      boundary_kind: "carrier" | "terminal";
    } | undefined;
    if (!boundary || boundary.boundary_kind === "terminal") return { items: [], total: 0 };
    const endRow = this.db.prepare(`
      SELECT MIN(start_after_step_order) AS end_order
      FROM run_message_boundaries
      WHERE session_id=? AND run_id=? AND boundary_kind='carrier' AND start_after_step_order>?
    `).get(input.sessionId, input.runId, boundary.start_after_step_order) as { end_order: number | null };
    const endOrder = endRow.end_order ?? Number.MAX_SAFE_INTEGER;
    const params = [input.sessionId, input.runId, boundary.start_after_step_order, endOrder] as const;
    const where = `step.session_id=? AND step.run_id=?
      AND step.step_order>? AND step.step_order<?
      AND step.step_type='protocol.envelope.v1'
      AND COALESCE(json_extract(step.payload, '$.type'), '')<>'state_sync'
      AND NOT (
        json_extract(step.payload, '$.type')='stream_output'
        AND COALESCE(json_extract(step.payload, '$.payload.phase'), '')<>'intent_complete'
      )
      AND NOT EXISTS (
        SELECT 1 FROM run_message_boundaries AS boundary
        WHERE boundary.session_id=step.session_id AND boundary.run_id=step.run_id
          AND boundary.boundary_kind='carrier'
          AND boundary.boundary_step_order=step.step_order
      )`;
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM run_steps AS step WHERE ${where}`)
      .get(...params) as { total: number };
    const rows = this.db.prepare(`
      SELECT ${ALIASED_RUN_STEP_SELECT_COLUMNS}
      FROM run_steps AS step
      WHERE ${where}
      ORDER BY step.step_order ASC
      LIMIT ? OFFSET ?
    `).all(...params, Math.max(1, Math.trunc(input.limit)), Math.max(0, Math.trunc(input.offset))) as unknown as RunStepRow[];
    const resourceRefsByStep = this.loadResourceRefs(rows.map((row) => row.id));
    return {
      items: rows.map((row) => rowToRunStep(row, resourceRefsByStep.get(row.id) ?? [])),
      total: Number(totalRow.total),
    };
  }

  private upsertRunMessageBoundary(
    sessionId: string,
    runId: string,
    messageId: string,
    stepOrder: number,
    kind: "carrier" | "terminal",
  ): void {
    const existing = this.db.prepare(`
      SELECT start_after_step_order, boundary_step_order, boundary_kind
      FROM run_message_boundaries
      WHERE session_id=? AND run_id=? AND message_id=?
    `).get(sessionId, runId, messageId) as {
      start_after_step_order: number;
      boundary_step_order: number | null;
      boundary_kind: "carrier" | "terminal";
    } | undefined;
    if (existing?.boundary_step_order != null && existing.boundary_step_order !== stepOrder) {
      throw new Error(`run message boundary conflict: ${messageId}`);
    }
    if (existing) {
      this.db.prepare(`
        UPDATE run_message_boundaries
        SET boundary_step_order=?, boundary_kind=?
        WHERE session_id=? AND run_id=? AND message_id=?
      `).run(stepOrder, kind, sessionId, runId, messageId);
      return;
    }
    const hasBoundary = this.db.prepare(`
      SELECT 1 FROM run_message_boundaries WHERE session_id=? AND run_id=? LIMIT 1
    `).get(sessionId, runId);
    const startAfter = kind === "carrier" && !hasBoundary ? 0 : stepOrder;
    this.db.prepare(`
      INSERT INTO run_message_boundaries (
        session_id, run_id, message_id, start_after_step_order, boundary_step_order, boundary_kind
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, runId, messageId, startAfter, stepOrder, kind);
  }

  getRunStepByEventId(eventId: string) {
    const row = this.db
      .prepare(`
          SELECT id, run_id, session_id, event_id, step_order, step_type, payload
        FROM run_steps
        WHERE event_id=?
      `)
      .get(eventId) as IdempotentRunStepDbRow | undefined;
    return row ? { ...row, payload: parseJsonObject(row.payload) } : null;
  }

  listRunSteps(input: {
    runId?: string | null;
    sessionId?: string | null;
    limit?: number;
    offset?: number;
  }): RunStepInfo[] {
    const rows = this.loadRunStepRows(input);
    const resourceRefsByStep = this.loadResourceRefs(rows.map((row) => row.id));
    return rows.map((row) => rowToRunStep(row, resourceRefsByStep.get(row.id) ?? []));
  }

  private loadRunStepRows(input: {
    runId?: string | null;
    sessionId?: string | null;
    limit?: number;
    offset?: number;
  }): RunStepRow[] {
    const limit = input.limit ?? 500;
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    if (input.runId) {
      if (input.sessionId) {
        return this.db
          .prepare(`
            SELECT ${RUN_STEP_SELECT_COLUMNS}
            FROM run_steps
            WHERE run_id=? AND session_id=?
              AND COALESCE(json_extract(payload, '$.type'), '')<>'state_sync'
              AND NOT (
                json_extract(payload, '$.type')='stream_output'
                AND COALESCE(json_extract(payload, '$.payload.phase'), '')<>'intent_complete'
              )
            ORDER BY step_order ASC
            LIMIT ? OFFSET ?
          `)
          .all(input.runId, input.sessionId, limit, offset) as unknown as RunStepRow[];
      }
      return this.db
        .prepare(`
          SELECT ${RUN_STEP_SELECT_COLUMNS}
          FROM run_steps
          WHERE run_id=?
            AND COALESCE(json_extract(payload, '$.type'), '')<>'state_sync'
            AND NOT (
              json_extract(payload, '$.type')='stream_output'
              AND COALESCE(json_extract(payload, '$.payload.phase'), '')<>'intent_complete'
            )
          ORDER BY step_order ASC
          LIMIT ? OFFSET ?
        `)
        .all(input.runId, limit, offset) as unknown as RunStepRow[];
    }

    return [];
  }

  private loadResourceRefs(stepIds: number[]): Map<number, Array<{ resource_id: string }>> {
    const refs = new Map<number, Array<{ resource_id: string }>>();
    if (stepIds.length === 0) {
      return refs;
    }
    const placeholders = stepIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT step_id, resource_id FROM step_resources WHERE step_id IN (${placeholders})`)
      .all(...stepIds) as unknown as Array<{ step_id: number; resource_id: string }>;
    for (const row of rows) {
      const current = refs.get(row.step_id) ?? [];
      current.push({ resource_id: row.resource_id });
      refs.set(row.step_id, current);
    }
    return refs;
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
    run_id: row.run_id,
    event_id: row.event_id,
    step_order: Number(row.step_order),
    step_type: row.step_type,
  };
}
