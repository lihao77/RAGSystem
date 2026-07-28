import type {
  CreateWorkflowTaskInput,
  UpdateWorkflowTaskInput,
  WorkflowTask,
  WorkflowTaskStatus,
  WorkflowTaskStore,
} from "@ragsystem/backend-core/contracts/runtime/workflow-tasks.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

const COLUMNS = `
  task_id::text AS task_id, subject, description, active_form, owner, status, blocks, blocked_by, metadata
`;

/** Tenant-bound PostgreSQL implementation for workflow task records. */
export class PostgresWorkflowTaskRepository implements WorkflowTaskStore {
  constructor(
    private readonly tenantId: TenantId,
    private readonly executor: PostgresMemoryExecutor,
  ) {}

  async create(sessionId: string, input: CreateWorkflowTaskInput): Promise<WorkflowTask> {
    const result = await this.executor.query(
      `INSERT INTO workflow_tasks (
        tenant_id, session_id, subject, description, active_form, owner, status, blocks, blocked_by, metadata
      ) VALUES ($1,$2,$3,$4,$5,'','pending','[]'::jsonb,'[]'::jsonb,$6::jsonb)
      RETURNING ${COLUMNS}`,
      [
        this.tenantId,
        sessionId,
        input.subject,
        input.description,
        input.activeForm?.trim() ?? "",
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!result.rows[0]) {
      throw new Error("workflow task insert returned no row");
    }
    return toWorkflowTask(result.rows[0]);
  }

  async get(sessionId: string, taskId: string): Promise<WorkflowTask | null> {
    const result = await this.executor.query(
      `SELECT ${COLUMNS} FROM workflow_tasks
       WHERE tenant_id=$1 AND session_id=$2 AND task_id=$3::bigint`,
      [this.tenantId, sessionId, taskId],
    );
    return result.rows[0] ? toWorkflowTask(result.rows[0]) : null;
  }

  async update(sessionId: string, taskId: string, input: UpdateWorkflowTaskInput): Promise<WorkflowTask | null> {
    return this.executor.transaction(async (tx) => {
      const relatedIds = uniqueIds([taskId, ...(input.addBlocks ?? []), ...(input.addBlockedBy ?? [])]);
      const locked = await tx.query(
        `SELECT ${COLUMNS} FROM workflow_tasks
         WHERE tenant_id=$1 AND session_id=$2 AND task_id = ANY($3::bigint[])
         ORDER BY task_id FOR UPDATE`,
        [this.tenantId, sessionId, relatedIds],
      );
      const byId = new Map(locked.rows.map((row) => {
        const task = toWorkflowTask(row);
        return [task.id, task] as const;
      }));
      const current = byId.get(taskId);
      if (!current) {
        return null;
      }
      for (const relatedId of relatedIds) {
        if (!byId.has(relatedId)) {
          throw new Error(`任务 #${relatedId} 不存在，不能建立依赖关系`);
        }
      }

      const next = applyUpdate(current, input);
      for (const blockedId of input.addBlocks ?? []) {
        const other = byId.get(blockedId);
        if (other) {
          next.blocks = addUnique(next.blocks, blockedId);
          other.blocked_by = addUnique(other.blocked_by, taskId);
        }
      }
      for (const blockerId of input.addBlockedBy ?? []) {
        const other = byId.get(blockerId);
        if (other) {
          next.blocked_by = addUnique(next.blocked_by, blockerId);
          other.blocks = addUnique(other.blocks, taskId);
        }
      }
      byId.set(taskId, next);

      for (const task of byId.values()) {
        await tx.query(
          `UPDATE workflow_tasks
           SET subject=$1, description=$2, active_form=$3, owner=$4, status=$5,
               blocks=$6::jsonb, blocked_by=$7::jsonb, metadata=$8::jsonb, updated_at=CURRENT_TIMESTAMP
           WHERE tenant_id=$9 AND session_id=$10 AND task_id=$11::bigint`,
          [
            task.subject,
            task.description,
            task.active_form,
            task.owner,
            task.status,
            JSON.stringify(task.blocks),
            JSON.stringify(task.blocked_by),
            JSON.stringify(task.metadata),
            this.tenantId,
            sessionId,
            task.id,
          ],
        );
      }
      return next;
    });
  }

  async delete(sessionId: string, taskId: string): Promise<boolean> {
    return this.executor.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT ${COLUMNS} FROM workflow_tasks
         WHERE tenant_id=$1 AND session_id=$2 ORDER BY task_id FOR UPDATE`,
        [this.tenantId, sessionId],
      );
      const tasks = locked.rows.map(toWorkflowTask);
      if (!tasks.some((task) => task.id === taskId)) {
        return false;
      }
      for (const task of tasks) {
        if (task.id === taskId) continue;
        const blocks = task.blocks.filter((id) => id !== taskId);
        const blockedBy = task.blocked_by.filter((id) => id !== taskId);
        if (blocks.length === task.blocks.length && blockedBy.length === task.blocked_by.length) continue;
        await tx.query(
          `UPDATE workflow_tasks
           SET blocks=$1::jsonb, blocked_by=$2::jsonb, updated_at=CURRENT_TIMESTAMP
           WHERE tenant_id=$3 AND session_id=$4 AND task_id=$5::bigint`,
          [JSON.stringify(blocks), JSON.stringify(blockedBy), this.tenantId, sessionId, task.id],
        );
      }
      const result = await tx.query(
        "DELETE FROM workflow_tasks WHERE tenant_id=$1 AND session_id=$2 AND task_id=$3::bigint",
        [this.tenantId, sessionId, taskId],
      );
      return Number(result.rowCount ?? 0) > 0;
    });
  }

  async list(sessionId: string): Promise<WorkflowTask[]> {
    const result = await this.executor.query(
      `SELECT ${COLUMNS} FROM workflow_tasks
       WHERE tenant_id=$1 AND session_id=$2 ORDER BY task_id ASC`,
      [this.tenantId, sessionId],
    );
    return result.rows.map(toWorkflowTask);
  }
}

function toWorkflowTask(row: Record<string, unknown>): WorkflowTask {
  return {
    id: String(row.task_id),
    subject: String(row.subject),
    description: String(row.description),
    active_form: String(row.active_form),
    owner: String(row.owner),
    status: row.status as WorkflowTaskStatus,
    blocks: stringArray(row.blocks),
    blocked_by: stringArray(row.blocked_by),
    metadata: record(row.metadata),
  };
}

function applyUpdate(task: WorkflowTask, input: UpdateWorkflowTaskInput): WorkflowTask {
  const next: WorkflowTask = {
    ...task,
    blocks: [...task.blocks],
    blocked_by: [...task.blocked_by],
    metadata: { ...task.metadata },
  };
  if (input.subject != null) next.subject = input.subject;
  if (input.description != null) next.description = input.description;
  if (input.activeForm != null) next.active_form = input.activeForm;
  if (input.owner != null) next.owner = input.owner;
  if (input.status != null) next.status = input.status;
  if (input.metadata) {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (value === null) delete next.metadata[key];
      else next.metadata[key] = value;
    }
  }
  return next;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return stringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function addUnique(items: string[], value: string): string[] {
  return items.includes(value) ? items : [...items, value];
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
}
