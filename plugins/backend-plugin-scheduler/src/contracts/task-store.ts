import type { TenantId, UserId } from "@ragsystem/backend-core/identity/types.js";
import type { SchedulerTask, SchedulerTaskCreate, SchedulerTaskUpdate } from "./task.js";

export interface SchedulerTaskClaim {
  tenantId: TenantId;
  taskId: string;
  claimToken: string;
  attemptId: string;
  leaseOwner: string;
  leaseExpiresAt: number;
}

/**
 * 租户内定时任务存储。任务私有于 owner（管理面按 ownerId 过滤）；
 * claim 系列方法始终扫全租户并承担多实例下的认领互斥。
 */
export interface SchedulerTaskStore {
  listTasks(tenantId: TenantId, ownerId?: UserId): Promise<SchedulerTask[]>;
  claimDueTasks(input: {
    now: number;
    leaseOwner: string;
    leaseSeconds?: number;
    limit?: number;
  }): Promise<SchedulerTaskClaim[]>;
  completeTaskClaim(input: { tenantId: TenantId; taskId: string; claimToken: string }): Promise<boolean>;
  releaseTaskClaim(input: { tenantId: TenantId; taskId: string; claimToken: string }): Promise<boolean>;
  getTask(tenantId: TenantId, taskId: string): Promise<SchedulerTask | null>;
  createTask(tenantId: TenantId, ownerId: string, input: SchedulerTaskCreate & { next_run?: number | null }): Promise<SchedulerTask>;
  updateTask(
    tenantId: TenantId,
    taskId: string,
    patch: Partial<Omit<SchedulerTask, "tenant_id" | "task_id">>,
    options?: { claimToken?: string },
  ): Promise<SchedulerTask | null>;
  deleteTask(tenantId: TenantId, taskId: string): Promise<boolean>;
}
