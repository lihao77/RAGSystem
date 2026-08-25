import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createTenantId, createUserId, type TenantId, type UserId } from "@ragsystem/backend-core/identity/types.js";

import type { SchedulerTaskClaim, SchedulerTaskStore } from "../../contracts/task-store.js";
import type { SchedulerTask, SchedulerTaskCreate } from "../../contracts/task.js";

const TASK_COLUMNS = "tenant_id, task_id, cron, task, team, entry_agent, session_id, enabled, permission_mode, owner_user_id, delivery_channel, delivery_target, delivery_bot_id, next_run, last_run, last_result, created_at, updated_at";

interface TaskRow {
  tenant_id: string;
  task_id: string;
  cron: string;
  task: string;
  team: string | null;
  entry_agent: string | null;
  session_id: string | null;
  enabled: boolean;
  permission_mode: string;
  owner_user_id: string;
  delivery_channel: string | null;
  delivery_target: string | null;
  delivery_bot_id: string | null;
  next_run: number | null;
  last_run: number | null;
  last_result: string | null;
  created_at: Date;
  updated_at: Date;
}

/** SaaS 控制库-backed 任务存储：认领互斥为 SKIP LOCKED 行级租约。 */
export class PostgresSchedulerTaskStore implements SchedulerTaskStore {
  constructor(private readonly pool: Pool) {}

  async listTasks(tenantId: TenantId, ownerId?: UserId): Promise<SchedulerTask[]> {
    const result = ownerId
      ? await this.pool.query<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM control_scheduler_tasks WHERE tenant_id=$1 AND owner_user_id=$2 ORDER BY task_id`, [tenantId, ownerId],
      )
      : await this.pool.query<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM control_scheduler_tasks WHERE tenant_id=$1 ORDER BY task_id`, [tenantId],
      );
    return result.rows.map(mapTask);
  }

  async claimDueTasks(input: Parameters<SchedulerTaskStore["claimDueTasks"]>[0]): Promise<SchedulerTaskClaim[]> {
    const leaseSeconds = Math.max(5, Math.min(Math.trunc(input.leaseSeconds ?? 300), 86_400));
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 500));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const due = await client.query<{ tenant_id: string; task_id: string }>(`
          SELECT task.tenant_id, task.task_id
          FROM control_scheduler_tasks task
          WHERE task.enabled=TRUE AND task.next_run IS NOT NULL AND task.next_run <= $1
            AND (task.lease_expires_at IS NULL OR task.lease_expires_at <= $1)
          ORDER BY task.tenant_id, task.task_id
          FOR UPDATE OF task SKIP LOCKED
          LIMIT $2
        `, [input.now, limit]);
        const claimed: SchedulerTaskClaim[] = [];
        for (const row of due.rows) {
          const claimToken = randomUUID();
          const attemptId = randomUUID();
          const leaseExpiresAt = input.now + leaseSeconds;
          const updated = await client.query(`
            UPDATE control_scheduler_tasks
            SET lease_owner=$1, lease_token=$2, lease_expires_at=$3,
                last_attempt_id=$4, attempt_count=attempt_count+1, updated_at=NOW()
            WHERE tenant_id=$5 AND task_id=$6
          `, [input.leaseOwner, claimToken, leaseExpiresAt, attemptId, row.tenant_id, row.task_id]);
          if ((updated.rowCount ?? 0) === 0) continue;
          claimed.push({
            tenantId: createTenantId(row.tenant_id),
            taskId: row.task_id,
            claimToken,
            attemptId,
            leaseOwner: input.leaseOwner,
            leaseExpiresAt,
          });
        }
        await client.query("COMMIT");
        return claimed;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async completeTaskClaim(input: { tenantId: TenantId; taskId: string; claimToken: string }): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE control_scheduler_tasks
      SET lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE tenant_id=$1 AND task_id=$2 AND lease_token=$3
    `, [input.tenantId, input.taskId, input.claimToken]);
    return (result.rowCount ?? 0) > 0;
  }

  async releaseTaskClaim(input: { tenantId: TenantId; taskId: string; claimToken: string }): Promise<boolean> {
    return this.completeTaskClaim(input);
  }

  async getTask(tenantId: TenantId, taskId: string): Promise<SchedulerTask | null> {
    const result = await this.pool.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM control_scheduler_tasks WHERE tenant_id=$1 AND task_id=$2`, [tenantId, taskId],
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async createTask(tenantId: TenantId, ownerId: string, input: SchedulerTaskCreate & { next_run?: number | null }): Promise<SchedulerTask> {
    const result = await this.pool.query<TaskRow>(`
      INSERT INTO control_scheduler_tasks(
        tenant_id, task_id, cron, task, team, entry_agent, session_id, enabled, permission_mode,
        owner_user_id, delivery_channel, delivery_target, delivery_bot_id, next_run
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING ${TASK_COLUMNS}
    `, [tenantId, input.task_id, input.cron, input.task, input.team, input.entry_agent, input.session_id,
      input.enabled ?? true, input.permission_mode, ownerId,
      input.delivery?.channel ?? null, input.delivery?.target ?? null, input.delivery?.bot_id ?? null,
      input.next_run ?? null]);
    return mapTask(requiredRow(result.rows));
  }

  async updateTask(
    tenantId: TenantId,
    taskId: string,
    patch: Partial<Omit<SchedulerTask, "tenant_id" | "task_id">>,
    options?: { claimToken?: string },
  ): Promise<SchedulerTask | null> {
    const current = await this.getTask(tenantId, taskId);
    if (!current) return null;
    const next = { ...current, ...defined(patch) };
    const result = await this.pool.query<TaskRow>(`
      UPDATE control_scheduler_tasks SET cron=$1, task=$2, team=$3, entry_agent=$4, session_id=$5, enabled=$6,
        permission_mode=$7, delivery_channel=$8, delivery_target=$9, delivery_bot_id=$10,
        next_run=$11, last_run=$12, last_result=$13, updated_at=NOW()
      WHERE tenant_id=$14 AND task_id=$15 AND ($16::text IS NULL OR lease_token=$16)
      RETURNING ${TASK_COLUMNS}
    `, [next.cron, next.task, next.team, next.entry_agent, next.session_id, next.enabled,
      next.permission_mode, next.delivery?.channel ?? null, next.delivery?.target ?? null, next.delivery?.bot_id ?? null,
      next.next_run, next.last_run, next.last_result, tenantId, taskId, options?.claimToken ?? null]);
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async deleteTask(tenantId: TenantId, taskId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM control_scheduler_tasks WHERE tenant_id=$1 AND task_id=$2", [tenantId, taskId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function requiredRow(rows: readonly TaskRow[]): TaskRow {
  const row = rows[0];
  if (!row) throw new Error("定时任务写入成功，但未返回记录");
  return row;
}

function mapTask(row: TaskRow): SchedulerTask {
  return {
    tenant_id: createTenantId(row.tenant_id),
    task_id: row.task_id,
    cron: row.cron,
    task: row.task,
    team: row.team,
    entry_agent: row.entry_agent,
    session_id: row.session_id,
    enabled: row.enabled === true,
    permission_mode: row.permission_mode as SchedulerTask["permission_mode"],
    owner_user_id: createUserId(row.owner_user_id),
    delivery: row.delivery_channel
      ? { channel: row.delivery_channel, target: row.delivery_target, bot_id: row.delivery_bot_id }
      : null,
    next_run: row.next_run,
    last_run: row.last_run,
    last_result: row.last_result,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
