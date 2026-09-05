import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BackgroundTaskService } from "../src/services/runtime/background-task-service.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("background task cancellation scope", () => {
  it("publishes callable completion into the session mailbox after reaching a terminal state", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-background-notify-"));
    tempRoots.push(outputDir);
    const settle = vi.fn(async () => true);
    const enqueued: Array<Record<string, any>> = [];
    const service = new BackgroundTaskService();
    service.setAgentMailbox({
      enqueue: vi.fn(async (input: Record<string, any>) => {
        enqueued.push(input);
        return input;
      }),
      settle,
    } as never, "tenant-1");
    const task = service.runCallable({
      outputDir,
      sessionId: "session-notify",
      run: async () => ({ success: true, content: "done" }),
    });

    await waitFor(() => enqueued.length === 1);
    expect(enqueued[0]).toEqual(expect.objectContaining({
      messageId: `bgnotify_${task.task_id}`,
      tenantId: "tenant-1",
      sessionId: "session-notify",
      targetThreadKey: "root",
      kind: "request",
      inputType: "system_notification",
      sourceKind: "system",
      visibleToUser: false,
    }));
    const text = String(enqueued[0]?.contentParts?.[0]?.text ?? "");
    expect(text).toContain("<task-notification>");
    expect(text).toContain(`<task-id>${task.task_id}</task-id>`);
    expect(text).toContain("<status>completed</status>");
    expect(settle).not.toHaveBeenCalled();
  });

  it("suppresses the completion notification for a task whose result was already polled", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-background-suppress-"));
    tempRoots.push(outputDir);
    const settle = vi.fn(async () => true);
    const service = new BackgroundTaskService();
    service.setAgentMailbox({
      enqueue: vi.fn(async () => ({})),
      settle,
    } as never, "tenant-1");
    const task = service.runCallable({
      outputDir,
      sessionId: "session-notify",
      run: async () => ({ success: true, content: "done" }),
    });

    await waitFor(() => service.getTaskSnapshot(task.task_id)?.status === "completed");
    service.suppressTaskNotification("session-notify", task.task_id);
    await service.waitForPersistence();

    expect(settle).toHaveBeenCalledWith({
      sessionId: "session-notify",
      messageId: `bgnotify_${task.task_id}`,
    });
  });

  it("suppresses a notification claimed before the enqueue lands (bash completion race)", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-background-suppress-early-"));
    tempRoots.push(outputDir);
    const enqueued: Array<Record<string, any>> = [];
    const service = new BackgroundTaskService();
    service.setAgentMailbox({
      enqueue: vi.fn(async (input: Record<string, any>) => {
        enqueued.push(input);
        return input;
      }),
      // settle 先于 enqueue 到达时对不存在的消息是空转——防线只剩内存抑制集合。
      settle: vi.fn(async () => false),
    } as never, "tenant-1");
    const task = service.runCallable({
      outputDir,
      sessionId: "session-notify",
      run: async () => ({ success: true, content: "done" }),
    });

    // 在完成入队落库前就抑制：模拟 bash 完成路径 output flush 窗口内轮询先到。
    service.suppressTaskNotification("session-notify", task.task_id);
    await waitFor(() => service.getTaskSnapshot(task.task_id)?.status === "completed");
    await service.waitForPersistence();

    expect(enqueued).toEqual([]);
  });

  it("notifies domain recovery handlers for expired durable tasks", async () => {
    const recovered = vi.fn(async () => undefined);
    const repository = {
      failExpiredRunning: vi.fn(async () => ["task-recovered"]),
      listActive: vi.fn(async () => [{
        tenant_id: "tenant-1",
        task_id: "task-recovered",
        description: "child",
        output_path: "",
        started_at: 1,
        status: "failed",
        return_code: 1,
        error: "lease expired",
        expires_at: null,
        run_id: "child-run",
        owner_task_id: null,
        session_id: "session-1",
        completed_at: 2,
        result_type: "agent_delegation_result",
        kind: "agent",
        cancel_supported: true,
        owner_instance_id: null,
        lease_expires_at: null,
      }]),
      deleteExpired: vi.fn(async () => 0),
      upsert: vi.fn(async () => undefined),
      listBySession: vi.fn(async () => []),
    };
    const service = new BackgroundTaskService({ repository: repository as never, tenantId: "tenant-1" });
    service.setOnTaskRecovered(recovered);

    await service.initialize();

    expect(recovered).toHaveBeenCalledWith(expect.objectContaining({
      task_id: "task-recovered",
      run_id: "child-run",
      status: "failed",
    }));
    expect(repository.deleteExpired).toHaveBeenCalledOnce();
  });

  it("retries a lease recovery record after restart even when expiry was already persisted", async () => {
    const recovered = vi.fn(async () => undefined);
    const repository = {
      failExpiredRunning: vi.fn(async () => []),
      listActive: vi.fn(async () => [{
        tenant_id: "tenant-1",
        task_id: "task-recovered",
        description: "child",
        output_path: "",
        started_at: 1,
        status: "failed",
        return_code: 1,
        error: "background task owner lease expired after runtime restart",
        expires_at: null,
        run_id: "child-run",
        owner_task_id: null,
        session_id: "session-1",
        completed_at: 2,
        result_type: "agent_delegation_result",
        kind: "agent",
        cancel_supported: true,
        owner_instance_id: null,
        lease_expires_at: null,
      }]),
      deleteExpired: vi.fn(async () => 0),
      upsert: vi.fn(async () => undefined),
      listBySession: vi.fn(async () => []),
    };
    const service = new BackgroundTaskService({ repository: repository as never, tenantId: "tenant-1" });
    service.setOnTaskRecovered(recovered);

    await service.initialize();

    expect(repository.failExpiredRunning).toHaveBeenCalledOnce();
    expect(recovered).toHaveBeenCalledWith(expect.objectContaining({ task_id: "task-recovered" }));
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
