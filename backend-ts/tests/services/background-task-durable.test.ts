import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AsyncBackgroundTaskRepository,
  DurableBackgroundTaskRecord,
} from "../../src/contracts/storage/background-task-repository.js";
import { BackgroundTaskService } from "../../src/services/runtime/background-task-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable BackgroundTaskService", () => {
  it("persists creation and terminal callable state", async () => {
    const repository = new InMemoryBackgroundTaskRepository();
    const service = new BackgroundTaskService({ repository, tenantId: "tenant-a", leaseSeconds: 60 });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-bg-"));
    roots.push(outputDir);

    const task = service.runCallable({ outputDir, run: async () => ({ success: true }) });
    await eventually(() => service.getTask(task.task_id)?.status === "completed");
    await service.waitForPersistence();

    expect(repository.records.get(`tenant-a:${task.task_id}`)).toMatchObject({
      tenant_id: "tenant-a",
      status: "completed",
      return_code: 0,
      owner_instance_id: null,
      lease_expires_at: null,
    });
    service.dispose();
  });

  it("recovers expired running tasks and hydrates terminal metadata", async () => {
    const repository = new InMemoryBackgroundTaskRepository();
    const stale = record({ task_id: "stale", status: "running", lease_expires_at: 1 });
    const completed = record({ task_id: "done", status: "completed", completed_at: 5, lease_expires_at: null });
    repository.records.set("tenant-a:stale", stale);
    repository.records.set("tenant-a:done", completed);

    const service = new BackgroundTaskService({ repository, tenantId: "tenant-a" });
    await service.initialize();

    expect(service.getTask("stale")).toMatchObject({ status: "failed", return_code: 1 });
    expect(service.getTask("done")).toMatchObject({ status: "completed" });
    expect(service.cancel("stale")).toBe(false);
    service.dispose();
  });

  it("reports running work per session until the callable finishes", async () => {
    const service = new BackgroundTaskService();
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-bg-idle-"));
    roots.push(outputDir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    service.runCallable({
      outputDir,
      sessionId: "session-a",
      run: async () => {
        await gate;
        return { success: true };
      },
    });

    expect(service.hasRunningTasks("session-a")).toBe(true);
    expect(service.hasRunningTasks("session-b")).toBe(false);
    release();
    await eventually(() => !service.hasRunningTasks("session-a"));
    service.dispose();
  });
});

class InMemoryBackgroundTaskRepository implements AsyncBackgroundTaskRepository {
  readonly records = new Map<string, DurableBackgroundTaskRecord>();
  async upsert(task: DurableBackgroundTaskRecord): Promise<void> {
    this.records.set(`${task.tenant_id}:${task.task_id}`, { ...task });
  }
  async listActive(tenantId: string, now: number): Promise<DurableBackgroundTaskRecord[]> {
    return [...this.records.values()].filter((task) => task.tenant_id === tenantId && (task.expires_at == null || task.expires_at > now));
  }
  async failExpiredRunning(tenantId: string, now: number, error: string): Promise<string[]> {
    const ids: string[] = [];
    for (const [key, task] of this.records) {
      if (task.tenant_id === tenantId && task.status === "running" && task.lease_expires_at != null && task.lease_expires_at <= now) {
        this.records.set(key, { ...task, status: "failed", return_code: 1, error, completed_at: now, owner_instance_id: null, lease_expires_at: null });
        ids.push(task.task_id);
      }
    }
    return ids;
  }
  async deleteExpired(tenantId: string, now: number): Promise<number> {
    let count = 0;
    for (const [key, task] of this.records) {
      if (task.tenant_id === tenantId && task.expires_at != null && task.expires_at <= now) {
        this.records.delete(key);
        count += 1;
      }
    }
    return count;
  }
}

function record(overrides: Partial<DurableBackgroundTaskRecord>): DurableBackgroundTaskRecord {
  return {
    tenant_id: "tenant-a", task_id: "task", description: "task", output_path: "output.log",
    started_at: 1, status: "running", return_code: null, error: null, expires_at: null,
    run_id: null, owner_task_id: null, session_id: null, completed_at: null, result_type: null,
    kind: "bash", cancel_supported: true, owner_instance_id: "old", lease_expires_at: 2,
    ...overrides,
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
