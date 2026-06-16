import fs from "node:fs";
import path from "node:path";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted" | string;

export interface StoredTask {
  id: string;
  subject: string;
  description: string;
  active_form: string;
  owner: string;
  status: TaskStatus;
  blocks: string[];
  blocked_by: string[];
  metadata: Record<string, unknown>;
}

export class TaskStore {
  constructor(private readonly dataRoot: string) {}

  createTask(sessionId: string, task: Omit<StoredTask, "id">): StoredTask {
    const taskId = this.nextTaskId(sessionId);
    const stored: StoredTask = { id: taskId, ...task };
    this.writeTask(sessionId, stored);
    return stored;
  }

  getTask(sessionId: string, taskId: string): StoredTask | null {
    const filePath = this.taskPath(sessionId, taskId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return normalizeTask(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  }

  listTasks(sessionId: string): StoredTask[] {
    const dir = this.taskDir(sessionId);
    const tasks: StoredTask[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "counter.json") {
        continue;
      }
      try {
        const task = normalizeTask(JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8")) as unknown);
        tasks.push(task);
      } catch {
        // Match Python's tolerant list_tasks behavior.
      }
    }
    return tasks.sort((left, right) => numericTaskId(left.id) - numericTaskId(right.id));
  }

  updateTask(
    sessionId: string,
    taskId: string,
    updates: Partial<StoredTask>,
    options: {
      addBlocks: string[];
      addBlockedBy: string[];
      metadata?: Record<string, unknown> | null | undefined;
    },
  ): StoredTask | null {
    const task = this.getTask(sessionId, taskId);
    if (!task) {
      return null;
    }
    if (updates.status === "deleted") {
      fs.rmSync(this.taskPath(sessionId, taskId), { force: true });
      return null;
    }
    Object.assign(task, updates);

    for (const blockedId of options.addBlocks.map(String)) {
      pushUnique(task.blocks, blockedId);
      const other = this.getTask(sessionId, blockedId);
      if (other) {
        pushUnique(other.blocked_by, taskId);
        this.writeTask(sessionId, other);
      }
    }
    for (const blockerId of options.addBlockedBy.map(String)) {
      pushUnique(task.blocked_by, blockerId);
      const other = this.getTask(sessionId, blockerId);
      if (other) {
        pushUnique(other.blocks, taskId);
        this.writeTask(sessionId, other);
      }
    }
    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        if (value === null) {
          delete task.metadata[key];
        } else {
          task.metadata[key] = value;
        }
      }
    }

    this.writeTask(sessionId, task);
    return task;
  }

  private nextTaskId(sessionId: string): string {
    const counterPath = path.join(this.taskDir(sessionId), "counter.json");
    const current = fs.existsSync(counterPath)
      ? Number((JSON.parse(fs.readFileSync(counterPath, "utf8")) as { counter?: unknown }).counter ?? 0)
      : 0;
    const next = Number.isFinite(current) ? Math.trunc(current) + 1 : 1;
    fs.writeFileSync(counterPath, JSON.stringify({ counter: next }), "utf8");
    return String(next);
  }

  private writeTask(sessionId: string, task: StoredTask): void {
    fs.writeFileSync(this.taskPath(sessionId, task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  private taskDir(sessionId: string): string {
    const dir = path.join(this.dataRoot, "tasks", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private taskPath(sessionId: string, taskId: string): string {
    return path.join(this.taskDir(sessionId), `${taskId}.json`);
  }
}

function normalizeTask(value: unknown): StoredTask {
  const record = isRecord(value) ? value : {};
  return {
    id: String(record.id ?? ""),
    subject: String(record.subject ?? ""),
    description: String(record.description ?? ""),
    active_form: String(record.active_form ?? ""),
    owner: String(record.owner ?? ""),
    status: String(record.status ?? "pending"),
    blocks: Array.isArray(record.blocks) ? record.blocks.map(String) : [],
    blocked_by: Array.isArray(record.blocked_by) ? record.blocked_by.map(String) : [],
    metadata: isRecord(record.metadata) ? { ...record.metadata } : {},
  };
}

function numericTaskId(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
