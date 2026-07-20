import type { RunStepInfo } from "../../../../contracts/common.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { parseJsonObject, stringifyJson } from "./helpers.js";
import { rowToRun, rowToRunStep } from "./mappers.js";
import type {
  AddRunStepInput,
  ConversationStoreTransaction,
  IRunStore,
  RunInfo,
  RunStepRecord,
} from "../../../../contracts/conversation-store/index.js";
import type { RunRow, RunStepRow } from "./types.js";

const RUN_STEP_SELECT_COLUMNS = "id, run_id, session_id, message_id, event_id, step_order, step_type, payload, created_at";

interface IdempotentRunStepRow {
  id: number;
  run_id: string;
  session_id: string;
  event_id: string;
  step_order: number;
  step_type: string;
}

interface IdempotentRunStepDbRow extends IdempotentRunStepRow {
  message_id: string | null;
  payload: string;
}

/** runs + run_steps 聚合根操作（迁移自 ConversationStore，方法体零改动）。 */
export class RunOps implements IRunStore {
  constructor(private readonly db: ConversationDb) {}

  createRun(input: {
    runId: string;
    sessionId: string;
    entrypoint?: string;
    status?: string;
    taskSummary?: string;
    requestId?: string | null;
    userId?: string | null;
    agentName?: string | null;
    threadKey?: string | null;
    parentRunId?: string | null;
    parentCallId?: string | null;
    childAgentId?: string | null;
  }): {
    run_id: string;
    session_id: string;
    status: string;
    thread_key: string;
    parent_run_id: string | null;
    parent_call_id: string | null;
    child_agent_id: string | null;
  } {
    const threadKey = input.threadKey?.trim() || "root";
    const status = input.status ?? "running";
    this.db
      .prepare(
        `
          INSERT INTO runs (
            run_id, session_id, tenant_id, entrypoint, status, task_summary,
            request_id, user_id, agent_name, thread_key, parent_run_id, parent_call_id, child_agent_id
          )
          SELECT ?, session_id, tenant_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      child_agent_id: input.childAgentId ?? null,
    };
  }

  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId: string | null = null): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE runs
          SET status=?, final_message_id=?, updated_at=CURRENT_TIMESTAMP
          WHERE run_id=? AND session_id=?
        `,
      )
      .run(status, finalMessageId, runId, sessionId);
    return Number(result.changes) > 0;
  }

  getRun(sessionId: string, runId: string): RunInfo | null {
    const row = this.db
      .prepare(
        `
          SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary,
                 request_id, user_id, agent_name, thread_key, parent_run_id, parent_call_id,
                 child_agent_id, final_message_id, created_at, updated_at
          FROM runs
          WHERE session_id=? AND run_id=?
        `,
      )
      .get(sessionId, runId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(sessionId: string, limit = 50): { items: RunInfo[]; total: number } {
    const totalRow = this.db
      .prepare("SELECT COUNT(1) AS cnt FROM runs WHERE session_id=?")
      .get(sessionId) as { cnt: number };
    const rows = this.db
      .prepare(
        `
          SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary,
                 request_id, user_id, agent_name, thread_key, parent_run_id, parent_call_id,
                 child_agent_id, final_message_id, created_at, updated_at
          FROM runs
          WHERE session_id=?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(sessionId, limit) as unknown as RunRow[];
    const items = rows.map(rowToRun);
    return { items, total: totalRow.cnt };
  }

  addRunStep(input: AddRunStepInput): RunStepRecord {
    return runInTransaction(this.db, () => this.addRunStepInTransaction(input));
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
        return toRunStepRecord(existing);
      }
    }
    const row = this.db
      .prepare("SELECT COALESCE(MAX(step_order), 0) + 1 AS next_order FROM run_steps WHERE session_id=? AND run_id=?")
      .get(input.sessionId, input.runId) as { next_order: number };
    const stepOrder = Number(row.next_order) || 1;
    const result = this.db
      .prepare(`
        INSERT INTO run_steps (run_id, session_id, message_id, event_id, step_order, step_type, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.runId,
        input.sessionId,
        input.messageId ?? null,
        eventId,
        stepOrder,
        input.stepType,
        stringifyJson(input.payload),
      );
    return {
      id: Number(result.lastInsertRowid),
      run_id: input.runId,
      event_id: eventId,
      step_order: stepOrder,
      step_type: input.stepType,
    };
  }

  getRunStepByEventId(eventId: string): ReturnType<ConversationStoreTransaction["getRunStepByEventId"]> {
    const row = this.db
      .prepare(`
        SELECT id, run_id, session_id, message_id, event_id, step_order, step_type, payload
        FROM run_steps
        WHERE event_id=?
      `)
      .get(eventId) as IdempotentRunStepDbRow | undefined;
    return row ? { ...row, payload: parseJsonObject(row.payload) } : null;
  }

  updateRunStepsMessageId(sessionId: string, runId: string, messageId: string): number {
    const result = this.db
      .prepare("UPDATE run_steps SET message_id=? WHERE session_id=? AND run_id=?")
      .run(messageId, sessionId, runId);
    return Number(result.changes);
  }

  listRunSteps(input: {
    runId?: string | null;
    messageId?: string | null;
    sessionId?: string | null;
    limit?: number;
  }): RunStepInfo[] {
    const rows = this.loadRunStepRows(input);
    const resourceRefsByStep = this.loadResourceRefs(rows.map((row) => row.id));
    return rows.map((row) => rowToRunStep(row, resourceRefsByStep.get(row.id) ?? []));
  }

  private loadRunStepRows(input: {
    runId?: string | null;
    messageId?: string | null;
    sessionId?: string | null;
    limit?: number;
  }): RunStepRow[] {
    const limit = input.limit ?? 500;
    if (input.messageId) {
      if (input.sessionId) {
        return this.db
          .prepare(`
            SELECT ${RUN_STEP_SELECT_COLUMNS}
            FROM run_steps
            WHERE message_id=? AND session_id=?
            ORDER BY step_order ASC
            LIMIT ?
          `)
          .all(input.messageId, input.sessionId, limit) as unknown as RunStepRow[];
      }
      return this.db
        .prepare(`
          SELECT ${RUN_STEP_SELECT_COLUMNS}
          FROM run_steps
          WHERE message_id=?
          ORDER BY step_order ASC
          LIMIT ?
        `)
        .all(input.messageId, limit) as unknown as RunStepRow[];
    }

    if (input.runId) {
      if (input.sessionId) {
        return this.db
          .prepare(`
            SELECT ${RUN_STEP_SELECT_COLUMNS}
            FROM run_steps
            WHERE run_id=? AND session_id=?
            ORDER BY step_order ASC
            LIMIT ?
          `)
          .all(input.runId, input.sessionId, limit) as unknown as RunStepRow[];
      }
      return this.db
        .prepare(`
          SELECT ${RUN_STEP_SELECT_COLUMNS}
          FROM run_steps
          WHERE run_id=?
          ORDER BY step_order ASC
          LIMIT ?
        `)
        .all(input.runId, limit) as unknown as RunStepRow[];
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
