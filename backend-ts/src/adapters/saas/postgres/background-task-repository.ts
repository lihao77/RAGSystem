import type {
  AsyncBackgroundTaskRepository,
  DurableBackgroundTaskRecord,
} from "../../../contracts/storage/background-task-repository.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

export class PostgresBackgroundTaskRepository implements AsyncBackgroundTaskRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async upsert(task: DurableBackgroundTaskRecord): Promise<void> {
    await this.executor.query(
      `INSERT INTO saas_background_tasks (
        tenant_id, task_id, description, output_path, started_at, status, return_code, error,
        expires_at, run_id, owner_task_id, session_id, completed_at, result_type, kind,
        cancel_supported, owner_instance_id, lease_expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (tenant_id, task_id) DO UPDATE SET
        description = EXCLUDED.description, output_path = EXCLUDED.output_path,
        status = EXCLUDED.status, return_code = EXCLUDED.return_code, error = EXCLUDED.error,
        expires_at = EXCLUDED.expires_at, completed_at = EXCLUDED.completed_at,
        result_type = EXCLUDED.result_type, cancel_supported = EXCLUDED.cancel_supported,
        owner_instance_id = EXCLUDED.owner_instance_id, lease_expires_at = EXCLUDED.lease_expires_at,
        updated_at = CURRENT_TIMESTAMP`,
      [task.tenant_id, task.task_id, task.description, task.output_path, task.started_at, task.status,
        task.return_code, task.error, task.expires_at, task.run_id, task.owner_task_id, task.session_id,
        task.completed_at, task.result_type, task.kind, task.cancel_supported, task.owner_instance_id,
        task.lease_expires_at],
    );
  }

  async listActive(tenantId: string, now: number): Promise<DurableBackgroundTaskRecord[]> {
    const result = await this.executor.query(
      `SELECT * FROM saas_background_tasks
       WHERE tenant_id = $1 AND (expires_at IS NULL OR expires_at > $2)
       ORDER BY started_at ASC`,
      [tenantId, now],
    );
    return result.rows.map(toRecord);
  }

  async failExpiredRunning(tenantId: string, now: number, error: string): Promise<string[]> {
    const result = await this.executor.query<{ task_id: string }>(
      `UPDATE saas_background_tasks SET status = 'failed', error = $3, return_code = 1,
         completed_at = $2, owner_instance_id = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $2
       RETURNING task_id`,
      [tenantId, now, error],
    );
    return result.rows.map((row) => String(row.task_id));
  }

  async deleteExpired(tenantId: string, now: number): Promise<number> {
    const result = await this.executor.query(
      "DELETE FROM saas_background_tasks WHERE tenant_id = $1 AND expires_at IS NOT NULL AND expires_at <= $2",
      [tenantId, now],
    );
    return result.rowCount ?? 0;
  }
}

function toRecord(row: Record<string, unknown>): DurableBackgroundTaskRecord {
  const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
  const nullableString = (value: unknown): string | null => value == null ? null : String(value);
  return {
    tenant_id: String(row.tenant_id), task_id: String(row.task_id), description: String(row.description),
    output_path: String(row.output_path), started_at: Number(row.started_at),
    status: row.status as DurableBackgroundTaskRecord["status"], return_code: nullableNumber(row.return_code),
    error: nullableString(row.error), expires_at: nullableNumber(row.expires_at), run_id: nullableString(row.run_id),
    owner_task_id: nullableString(row.owner_task_id), session_id: nullableString(row.session_id),
    completed_at: nullableNumber(row.completed_at), result_type: nullableString(row.result_type), kind: String(row.kind),
    cancel_supported: Boolean(row.cancel_supported), owner_instance_id: nullableString(row.owner_instance_id),
    lease_expires_at: nullableNumber(row.lease_expires_at),
  };
}
