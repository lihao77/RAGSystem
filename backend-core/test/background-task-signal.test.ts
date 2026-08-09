import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BackgroundTaskService } from "../src/services/runtime/background-task-service.js";
import { SessionNotificationQueue } from "../src/services/runtime/session-notification-queue.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("background task cancellation scope", () => {
  it("publishes callable completion after transitioning to a terminal state", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-background-notify-"));
    tempRoots.push(outputDir);
    const queue = new SessionNotificationQueue();
    const service = new BackgroundTaskService({ notificationQueue: queue });
    const task = service.runCallable({
      outputDir,
      sessionId: "session-notify",
      run: async () => ({ success: true, content: "done" }),
    });

    await waitFor(() => queue.peek("session-notify"));
    const payload = queue.drain("session-notify")[0];
    expect(payload).toEqual(expect.objectContaining({
      task_id: task.task_id,
      status: "completed",
      success: true,
    }));
  });

  it("uses a task-local signal that is independent from the parent run", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-background-signal-"));
    tempRoots.push(outputDir);
    const service = new BackgroundTaskService();
    const parentAbort = new AbortController();
    let taskSignal: AbortSignal | null = null;
    const getTaskSignal = (): AbortSignal | null => taskSignal;

    const task = service.runCallable({
      outputDir,
      run: ({ signal }) => new Promise((resolve) => {
        taskSignal = signal;
        signal.addEventListener("abort", () => resolve({ success: false, reason: "cancelled" }), { once: true });
      }),
    });

    await waitFor(() => getTaskSignal() !== null);
    expect(getTaskSignal()).not.toBe(parentAbort.signal);
    expect(getTaskSignal()?.aborted).toBe(false);

    parentAbort.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getTaskSignal()?.aborted).toBe(false);
    expect(service.getTaskSnapshot(task.task_id)?.status).toBe("running");

    expect(service.cancel(task.task_id)).toBe(true);
    await waitFor(() => getTaskSignal()?.aborted === true);
    expect(service.getTaskSnapshot(task.task_id)?.status).toBe("cancelled");
  });

  it("persists cancellation even when a legacy cleanup hook throws", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-background-cancel-hook-"));
    tempRoots.push(outputDir);
    const service = new BackgroundTaskService();
    const task = service.runCallable({
      outputDir,
      cancel: () => { throw new Error("cleanup failed"); },
      run: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ success: false }), { once: true });
      }),
    });

    expect(service.cancel(task.task_id)).toBe(true);
    expect(service.getTaskSnapshot(task.task_id)?.status).toBe("cancelled");
  });

  it("waits for a callable to unwind after task cancellation", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-background-cancel-wait-"));
    tempRoots.push(outputDir);
    const service = new BackgroundTaskService();
    let unwound = false;
    const task = service.runCallable({
      outputDir,
      run: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => { unwound = true; resolve({ success: false }); }, 30);
        }, { once: true });
      }),
    });

    await waitFor(() => service.getTaskSnapshot(task.task_id)?.status === "running");
    expect(await service.cancelAndWait(task.task_id)).toBe(true);
    expect(unwound).toBe(true);
    expect(service.getTaskSnapshot(task.task_id)?.status).toBe("cancelled");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
