import type { RunStepInfo } from "../../../contracts/common.js";
import type { AddRunStepInput, IRunStore, RunInfo, RunStepRecord } from "../../../contracts/conversation-store/index.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";
import type { AsyncRunStore } from "../../../contracts/async-persistence-ports.js";
export type { AsyncRunStore } from "../../../contracts/async-persistence-ports.js";

const runColumns = `run_id, session_id, tenant_id, entrypoint, status, task_summary,
  request_id, user_id, agent_name, thread_key, parent_run_id, parent_call_id,
  child_agent_id, final_message_id, created_at, updated_at`;

function textOrNull(value: unknown): string | null { return value == null ? null : String(value); }
function run(row: Record<string, unknown>): RunInfo {
  return {
    run_id: String(row.run_id), session_id: String(row.session_id), tenant_id: String(row.tenant_id ?? ""),
    entrypoint: textOrNull(row.entrypoint), status: String(row.status), task_summary: textOrNull(row.task_summary),
    request_id: textOrNull(row.request_id), user_id: textOrNull(row.user_id), agent_name: textOrNull(row.agent_name),
    thread_key: String(row.thread_key ?? "root"), parent_run_id: textOrNull(row.parent_run_id), parent_call_id: textOrNull(row.parent_call_id),
    child_agent_id: textOrNull(row.child_agent_id), final_message_id: textOrNull(row.final_message_id),
    created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

export class PostgresRunRepository implements AsyncRunStore {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async createRun(input: Parameters<IRunStore["createRun"]>[0] & { tenantId: string }): Promise<ReturnType<IRunStore["createRun"]>> {
    const threadKey = input.threadKey?.trim() || "root";
    const status = input.status ?? "running";
    await this.executor.query(`INSERT INTO saas_runs
      (tenant_id, run_id, session_id, entrypoint, status, task_summary, request_id, user_id, agent_name,
       thread_key, parent_run_id, parent_call_id, child_agent_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (tenant_id, run_id) DO NOTHING`, [input.tenantId, input.runId, input.sessionId, input.entrypoint ?? "execute", status,
      input.taskSummary ?? "", input.requestId ?? null, input.userId ?? null, input.agentName ?? null,
      threadKey, input.parentRunId ?? null, input.parentCallId ?? null, input.childAgentId ?? null]);
    return { run_id: input.runId, session_id: input.sessionId, status, thread_key: threadKey,
      parent_run_id: input.parentRunId ?? null, parent_call_id: input.parentCallId ?? null, child_agent_id: input.childAgentId ?? null };
  }

  async updateRunStatus(tenantId: string, runId: string, sessionId: string, status: string, finalMessageId: string | null = null): Promise<boolean> {
    const result = await this.executor.query("UPDATE saas_runs SET status=$1, final_message_id=$2, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$3 AND run_id=$4 AND session_id=$5", [status, finalMessageId, tenantId, runId, sessionId]);
    return Number(result.rowCount ?? 0) > 0;
  }

  async getRun(tenantId: string, sessionId: string, runId: string): Promise<RunInfo | null> {
    const result = await this.executor.query(`SELECT ${runColumns} FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3`, [tenantId, sessionId, runId]);
    return result.rows[0] ? run(result.rows[0]) : null;
  }

  async listRuns(tenantId: string, sessionId: string, limit = 50): Promise<{ items: RunInfo[]; total: number }> {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const [count, rows] = await Promise.all([
      this.executor.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM saas_runs WHERE tenant_id=$1 AND session_id=$2", [tenantId, sessionId]),
      this.executor.query(`SELECT ${runColumns} FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at DESC LIMIT $3`, [tenantId, sessionId, bounded]),
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

  async addRunStep(input: AddRunStepInput & { tenantId: string }): Promise<RunStepRecord> {
    return this.executor.transaction(async (tx) => {
      const next = await tx.query<{ next_order: number | string }>("SELECT COALESCE(MAX(step_order),0)+1 AS next_order FROM saas_run_steps WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 FOR UPDATE", [input.tenantId, input.sessionId, input.runId]);
      const order = Number(next.rows[0]?.next_order ?? 1);
      const inserted = await tx.query<{ id: number | string }>(`INSERT INTO saas_run_steps (tenant_id, run_id, session_id, message_id, step_order, step_type, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`, [input.tenantId, input.runId, input.sessionId, input.messageId ?? null, order, input.stepType, JSON.stringify(input.payload)]);
      return { id: Number(inserted.rows[0]?.id), run_id: input.runId, step_order: order, step_type: input.stepType };
    });
  }

  async updateRunStepsMessageId(tenantId: string, sessionId: string, runId: string, messageId: string): Promise<number> {
    const result = await this.executor.query("UPDATE saas_run_steps SET message_id=$1 WHERE tenant_id=$2 AND session_id=$3 AND run_id=$4", [messageId, tenantId, sessionId, runId]);
    return Number(result.rowCount ?? 0);
  }

  async listRunSteps(input: { tenantId: string; runId?: string | null; messageId?: string | null; sessionId?: string | null; limit?: number }): Promise<RunStepInfo[]> {
    const clauses: string[] = ["tenant_id = $1"]; const params: unknown[] = [input.tenantId];
    const add = (sql: string, value: unknown): void => { params.push(value); clauses.push(sql.replace("?", `$${params.length}`)); };
    if (input.runId) add("run_id = ?", input.runId);
    if (input.messageId) add("message_id = ?", input.messageId);
    if (input.sessionId) add("session_id = ?", input.sessionId);
    params.push(Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 500))));
    const result = await this.executor.query<Record<string, unknown>>(`SELECT id, run_id, session_id, message_id, step_order, step_type, payload, created_at FROM saas_run_steps WHERE ${clauses.join(" AND ")} ORDER BY step_order ASC LIMIT $${params.length}`, params);
    return result.rows.map((row) => ({ id: Number(row.id), run_id: String(row.run_id), session_id: String(row.session_id), message_id: textOrNull(row.message_id), step_order: Number(row.step_order), step_type: String(row.step_type), payload: typeof row.payload === "string" ? JSON.parse(row.payload) as Record<string, unknown> : (row.payload as Record<string, unknown> ?? {}), created_at: new Date(String(row.created_at)).toISOString(), resource_refs: [] }));
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
