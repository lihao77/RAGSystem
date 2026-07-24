import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Envelope } from "../../src/contracts/events.js";
import {
  BackgroundTaskService,
  type PublicBackgroundTask,
} from "../../src/services/runtime/background-task-service.js";
import { SessionNotificationQueue } from "../../src/services/runtime/session-notification-queue.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  vi.restoreAllMocks();
});

describe("BackgroundTaskService management", () => {
  it("returns Session-scoped public tasks with instance-aware cancellation state", async () => {
    const service = new BackgroundTaskService();
    const outputDir = tempRoot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = service.runCallable({
      outputDir,
      sessionId: "session-a",
      description: "not cancellable",
      run: async () => { await gate; return { success: true }; },
    });
    const completed = service.runCallable({
      outputDir,
      sessionId: "session-a",
      description: "already done",
      run: async () => ({ success: true }),
    });
    service.runCallable({
      outputDir,
      sessionId: "session-b",
      description: "other Session",
      run: async () => ({ success: true }),
    });
    await eventually(() => service.getTask(completed.task_id)?.status === "completed");

    const tasks = await service.listSessionTasks("session-a");
    expect(tasks).toHaveLength(2);
    expect(tasks.every(isPublicTask)).toBe(true);
    expect(tasks.find((task) => task.task_id === running.task_id)).toMatchObject({
      status: "running",
      cancel_supported: false,
      cancel_available: false,
      cancel_unavailable_reason: "not_cancellable",
    });
    expect(tasks.find((task) => task.task_id === completed.task_id)).toMatchObject({
      status: "completed",
      cancel_available: false,
      cancel_unavailable_reason: "already_finished",
    });
    expect(await service.cancelSessionTask("session-a", running.task_id)).toMatchObject({
      cancelled: false,
      reason: "not_cancellable",
    });
    expect(await service.cancelSessionTask("session-b", running.task_id)).toMatchObject({
      cancelled: false,
      reason: "not_found",
    });
    expect(await service.cancelSessionTask("session-a", completed.task_id)).toMatchObject({
      cancelled: false,
      reason: "already_finished",
    });

    release();
    await eventually(() => service.getTask(running.task_id)?.status === "completed");
    service.dispose();
  });

  it("publishes started and terminal lifecycle events without leaking private task fields", async () => {
    const events: Envelope[] = [];
    const clientEvents = publisher(events);
    const service = new BackgroundTaskService({ clientEvents });
    const outputDir = tempRoot();
    const success = service.runCallable({
      outputDir,
      sessionId: "session-a",
      run: async () => ({ success: true }),
    });
    const failure = service.runCallable({
      outputDir,
      sessionId: "session-a",
      run: async () => ({ success: false }),
    });
    await eventually(() => (
      service.getTask(success.task_id)?.status === "completed"
      && service.getTask(failure.task_id)?.status === "failed"
    ));

    expect(lifecycle(events, success.task_id).map((item) => item.action)).toEqual(["started", "completed"]);
    expect(lifecycle(events, failure.task_id).map((item) => item.action)).toEqual(["started", "failed"]);
    expect(lifecycle(events, failure.task_id).at(-1)?.task).toMatchObject({ status: "failed" });
    for (const item of lifecycle(events, success.task_id)) {
      expect(item.task).not.toHaveProperty("output_path");
      expect(item.task).not.toHaveProperty("session_id");
    }
    service.dispose();
  });

  it("cancels an owned bash task once, emits no agent notification, and schedules an idle check", async () => {
    const events: Envelope[] = [];
    const notificationQueue = new SessionNotificationQueue();
    const service = new BackgroundTaskService({ notificationQueue, clientEvents: publisher(events) });
    const schedule = vi.spyOn(service, "scheduleAutoTrigger").mockImplementation(() => undefined);
    const outputDir = tempRoot();
    const task = service.spawnBash({
      command: `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`,
      bashExecutable: null,
      cwd: outputDir,
      outputDir,
      sessionId: "session-a",
    });

    expect((await service.listSessionTasks("session-a")).find((item) => item.task_id === task.task_id)).toMatchObject({
      cancel_supported: true,
      cancel_available: true,
      cancel_unavailable_reason: null,
    });
    expect(await service.cancelSessionTask("session-a", task.task_id)).toEqual({
      task_id: task.task_id,
      cancelled: true,
      status: "cancelled",
      reason: null,
    });
    expect(await service.cancelSessionTask("session-a", task.task_id)).toMatchObject({
      cancelled: false,
      status: "cancelled",
      reason: "already_finished",
    });
    expect(notificationQueue.peek("session-a")).toBe(false);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith("session-a");

    await new Promise((resolve) => setTimeout(resolve, 1_250));
    expect(lifecycle(events, task.task_id).map((item) => item.action)).toEqual(["started", "cancelled"]);
    expect(notificationQueue.peek("session-a")).toBe(false);
    service.dispose();
  });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-bg-management-"));
  roots.push(root);
  return root;
}

function isPublicTask(task: PublicBackgroundTask): boolean {
  return !("output_path" in task) && !("session_id" in task);
}

function publisher(events: Envelope[]) {
  return {
    publish: vi.fn(async (_sessionId: string, event: Envelope) => {
      events.push(event);
      return {};
    }),
  } as never;
}

function lifecycle(events: Envelope[], taskId: string): Array<{ action: string; task: Record<string, unknown> }> {
  return events.flatMap((event) => {
    if (event.type !== "state_sync") return [];
    const payload = event.payload as Record<string, unknown>;
    const detail = payload.detail as Record<string, unknown> | undefined;
    const task = detail?.task as Record<string, unknown> | undefined;
    if (detail?.entity !== "background_task" || task?.task_id !== taskId) return [];
    return [{ action: String(detail.action), task }];
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
