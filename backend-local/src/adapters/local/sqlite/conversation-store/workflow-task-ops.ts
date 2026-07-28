import type {
  CreateWorkflowTaskInput,
  UpdateWorkflowTaskInput,
  WorkflowTask,
  WorkflowTaskStatus,
} from "@ragsystem/backend-core/contracts/runtime/workflow-tasks.js";
import { parseJsonObject, stringifyJson } from "./helpers.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";

interface WorkflowTaskRow {
  task_id: number | bigint;
  subject: string;
  description: string;
  active_form: string;
  owner: string;
  status: WorkflowTaskStatus;
  blocks: string | null;
  blocked_by: string | null;
  metadata: string | null;
}

const SELECT_COLUMNS = `
  task_id, subject, description, active_form, owner, status, blocks, blocked_by, metadata
`;

/** Durable workflow task aggregate backed by the local conversation database. */
export class WorkflowTaskOps {
  constructor(private readonly db: ConversationDb) {}

  create(sessionId: string, input: CreateWorkflowTaskInput): WorkflowTask {
    const inserted = this.db.prepare(
      `INSERT INTO workflow_tasks (
        session_id, subject, description, active_form, owner, status, blocks, blocked_by, metadata
      ) VALUES (?, ?, ?, ?, '', 'pending', '[]', '[]', ?)`,
    ).run(
      sessionId,
      input.subject,
      input.description,
      input.activeForm?.trim() ?? "",
      stringifyJson(input.metadata ?? {}),
    );
    return this.getRequired(sessionId, String(inserted.lastInsertRowid));
  }

  get(sessionId: string, taskId: string): WorkflowTask | null {
    const row = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM workflow_tasks WHERE session_id=? AND task_id=?`,
    ).get(sessionId, taskId) as WorkflowTaskRow | undefined;
    return row ? toWorkflowTask(row) : null;
  }

  update(sessionId: string, taskId: string, input: UpdateWorkflowTaskInput): WorkflowTask | null {
    return runInTransaction(this.db, () => {
      const current = this.get(sessionId, taskId);
      if (!current) {
        return null;
      }
      const next = applyUpdate(current, input);
      const related = uniqueIds([...(input.addBlocks ?? []), ...(input.addBlockedBy ?? [])]);
      const relatedTasks = new Map<string, WorkflowTask>();
      for (const relatedId of related) {
        const relatedTask = this.get(sessionId, relatedId);
        if (!relatedTask) {
          throw new Error(`任务 #${relatedId} 不存在，不能建立依赖关系`);
        }
        relatedTasks.set(relatedId, relatedTask);
      }

      for (const blockedId of input.addBlocks ?? []) {
        const other = relatedTasks.get(blockedId);
        if (other) {
          next.blocks = addUnique(next.blocks, blockedId);
          other.blocked_by = addUnique(other.blocked_by, taskId);
        }
      }
      for (const blockerId of input.addBlockedBy ?? []) {
        const other = relatedTasks.get(blockerId);
        if (other) {
          next.blocked_by = addUnique(next.blocked_by, blockerId);
          other.blocks = addUnique(other.blocks, taskId);
        }
      }

      this.write(sessionId, next);
      for (const task of relatedTasks.values()) {
        this.write(sessionId, task);
      }
      return next;
    });
  }

  delete(sessionId: string, taskId: string): boolean {
    return runInTransaction(this.db, () => {
      if (!this.get(sessionId, taskId)) {
        return false;
      }
      for (const task of this.list(sessionId)) {
        if (task.id === taskId) continue;
        const blocks = task.blocks.filter((id) => id !== taskId);
        const blockedBy = task.blocked_by.filter((id) => id !== taskId);
        if (blocks.length === task.blocks.length && blockedBy.length === task.blocked_by.length) continue;
        this.write(sessionId, { ...task, blocks, blocked_by: blockedBy });
      }
      const result = this.db.prepare("DELETE FROM workflow_tasks WHERE session_id=? AND task_id=?").run(sessionId, taskId);
      return Number(result.changes) > 0;
    });
  }

  list(sessionId: string): WorkflowTask[] {
    const rows = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM workflow_tasks WHERE session_id=? ORDER BY task_id ASC`,
    ).all(sessionId) as unknown as WorkflowTaskRow[];
    return rows.map(toWorkflowTask);
  }

  private getRequired(sessionId: string, taskId: string): WorkflowTask {
    const task = this.get(sessionId, taskId);
    if (!task) {
      throw new Error(`workflow task insert failed: ${taskId}`);
    }
    return task;
  }

  private write(sessionId: string, task: WorkflowTask): void {
    this.db.prepare(
      `UPDATE workflow_tasks
       SET subject=?, description=?, active_form=?, owner=?, status=?, blocks=?, blocked_by=?, metadata=?, updated_at=CURRENT_TIMESTAMP
       WHERE session_id=? AND task_id=?`,
    ).run(
      task.subject,
      task.description,
      task.active_form,
      task.owner,
      task.status,
      JSON.stringify(task.blocks),
      JSON.stringify(task.blocked_by),
      stringifyJson(task.metadata),
      sessionId,
      task.id,
    );
  }
}

function toWorkflowTask(row: WorkflowTaskRow): WorkflowTask {
  return {
    id: String(row.task_id),
    subject: row.subject,
    description: row.description,
    active_form: row.active_form,
    owner: row.owner,
    status: row.status,
    blocks: parseStringArray(row.blocks),
    blocked_by: parseStringArray(row.blocked_by),
    metadata: parseJsonObject(row.metadata),
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

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function addUnique(items: string[], value: string): string[] {
  return items.includes(value) ? items : [...items, value];
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
