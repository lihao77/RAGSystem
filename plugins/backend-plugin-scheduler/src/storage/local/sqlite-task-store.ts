import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createTenantId, createUserId, type TenantId, type UserId } from "@ragsystem/backend-core/identity/types.js";

import type { SchedulerTaskClaim, SchedulerTaskStore } from "../../contracts/task-store.js";
import type { SchedulerTask, SchedulerTaskCreate } from "../../contracts/task.js";

interface TaskRow {
  tenant_id: string;
  task_id: string;
  cron: string;
  task: string;
  team: string | null;
  entry_agent: string | null;
  session_id: string | null;
  enabled: number;
  permission_mode: string;
  owner_user_id: string;
  delivery_channel: string | null;
  delivery_target: string | null;
  delivery_bot_id: string | null;
  next_run: number | null;
  last_run: number | null;
  last_result: string | null;
  created_at: string;
  updated_at: string;
}

const TASK_COLUMNS = "tenant_id, task_id, cron, task, team, entry_agent, session_id, enabled, permission_mode, owner_user_id, delivery_channel, delivery_target, delivery_bot_id, next_run, last_run, last_result, created_at, updated_at";

/**
 * Local 控制库-backed 任务存储。claim 互斥为进程内存租约（Local 单进程假设，
 * 与 daemon-feishu 的 SqliteBotRepository 行为一致）；跨进程/多实例由 SaaS Postgres 存储承担。
 */
export class SqliteSchedulerTaskStore implements SchedulerTaskStore {
  private readonly claims = new Map<string, SchedulerTaskClaim>();

  constructor(private readonly db: DatabaseSync) {}

  async listTasks(tenantId: TenantId, ownerId?: UserId): Promise<SchedulerTask[]> {
    const rows = ownerId
      ? this.db.prepare(`SELECT ${TASK_COLUMNS} FROM scheduler_tasks WHERE tenant_id=? AND owner_user_id=? ORDER BY task_id`).all(tenantId, ownerId)
      : this.db.prepare(`SELECT ${TASK_COLUMNS} FROM scheduler_tasks WHERE tenant_id=? ORDER BY task_id`).all(tenantId);
    return rows.map((row) => mapTask(row as unknown as TaskRow));
  }

  async claimDueTasks(input: Parameters<SchedulerTaskStore["claimDueTasks"]>[0]): Promise<SchedulerTaskClaim[]> {
    const leaseSeconds = Math.max(5, Math.min(Math.trunc(input.leaseSeconds ?? 300), 86_400));
    const due = this.db.prepare(
      "SELECT tenant_id, task_id FROM scheduler_tasks WHERE enabled=1 AND next_run IS NOT NULL AND next_run <= ? ORDER BY tenant_id, task_id",
    ).all(input.now) as Array<{ tenant_id: string; task_id: string }>;
    const claims: SchedulerTaskClaim[] = [];
    for (const row of due.slice(0, input.limit ?? 100)) {
      const key = `${row.tenant_id}:${row.task_id}`;
      const existing = this.claims.get(key);
      if (existing && existing.leaseExpiresAt > input.now) continue;
      const claim: SchedulerTaskClaim = {
        tenantId: createTenantId(row.tenant_id),
        taskId: row.task_id,
        claimToken: randomUUID(),
        attemptId: randomUUID(),
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.now + leaseSeconds,
      };
      this.claims.set(key, claim);
      claims.push(claim);
    }
    return claims;
  }

  async completeTaskClaim(input: { tenantId: TenantId; taskId: string; claimToken: string }): Promise<boolean> {
    const key = `${input.tenantId}:${input.taskId}`;
    const claim = this.claims.get(key);
    if (!claim || claim.claimToken !== input.claimToken) return false;
    this.claims.delete(key);
    return true;
  }

  async releaseTaskClaim(input: { tenantId: TenantId; taskId: string; claimToken: string }): Promise<boolean> {
    return this.completeTaskClaim(input);
  }

  async getTask(tenantId: TenantId, taskId: string): Promise<SchedulerTask | null> {
    const row = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM scheduler_tasks WHERE tenant_id=? AND task_id=?`)
      .get(tenantId, taskId) as unknown as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  async createTask(tenantId: TenantId, ownerId: string, input: SchedulerTaskCreate & { next_run?: number | null }): Promise<SchedulerTask> {
    this.db.prepare(`
      INSERT INTO scheduler_tasks(
        tenant_id, task_id, cron, task, team, entry_agent, session_id, enabled, permission_mode,
        owner_user_id, delivery_channel, delivery_target, delivery_bot_id, next_run, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      tenantId, input.task_id, input.cron, input.task, input.team ?? null, input.entry_agent ?? null, input.session_id ?? null,
      (input.enabled ?? true) ? 1 : 0, input.permission_mode ?? "relaxed", ownerId,
      input.delivery?.channel ?? null, input.delivery?.target ?? null, input.delivery?.bot_id ?? null,
      input.next_run ?? null,
    );
    const created = await this.getTask(tenantId, input.task_id);
    if (!created) throw new Error(`定时任务创建失败: ${input.task_id}`);
    return created;
  }

  async updateTask(
    tenantId: TenantId,
    taskId: string,
    patch: Partial<Omit<SchedulerTask, "tenant_id" | "task_id">>,
  ): Promise<SchedulerTask | null> {
    const current = await this.getTask(tenantId, taskId);
    if (!current) return null;
    const next = { ...current, ...defined(patch) };
    this.db.prepare(`
      UPDATE scheduler_tasks SET cron=?, task=?, team=?, entry_agent=?, session_id=?, enabled=?,
        permission_mode=?, delivery_channel=?, delivery_target=?, delivery_bot_id=?,
        next_run=?, last_run=?, last_result=?, updated_at=CURRENT_TIMESTAMP
      WHERE tenant_id=? AND task_id=?
    `).run(
      next.cron, next.task, next.team, next.entry_agent, next.session_id, next.enabled ? 1 : 0,
      next.permission_mode, next.delivery?.channel ?? null, next.delivery?.target ?? null, next.delivery?.bot_id ?? null,
      next.next_run, next.last_run, next.last_result, tenantId, taskId,
    );
    return this.getTask(tenantId, taskId);
  }

  async deleteTask(tenantId: TenantId, taskId: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM scheduler_tasks WHERE tenant_id=? AND task_id=?").run(tenantId, taskId).changes > 0;
  }
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
    enabled: row.enabled === 1,
    permission_mode: row.permission_mode as SchedulerTask["permission_mode"],
    owner_user_id: createUserId(row.owner_user_id),
    delivery: row.delivery_channel
      ? { channel: row.delivery_channel, target: row.delivery_target, bot_id: row.delivery_bot_id }
      : null,
    next_run: row.next_run,
    last_run: row.last_run,
    last_result: row.last_result,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
