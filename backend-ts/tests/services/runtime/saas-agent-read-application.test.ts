import { describe, expect, it, vi } from "vitest";

import { SaaSAgentReadApplication } from "../../../src/adapters/saas/application/execution/saas-agent-read-application.js";

describe("SaaSAgentReadApplication", () => {
  it("maps the latest PostgreSQL run to session task status", async () => {
    const app = new SaaSAgentReadApplication(
      "tenant-a",
      { getSession: vi.fn(async () => ({ session_id: "s1", tenant_id: "tenant-a" })) } as never,
      { listRuns: vi.fn(async () => ({ total: 1, items: [{ run_id: "r1", session_id: "s1", status: "running", request_id: "req-1", entrypoint: "stream", task_summary: "hello", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z" }] })) } as never,
      { listOutboxForReplay: vi.fn() } as never,
    );

    await expect(app.getSessionTaskStatus("s1")).resolves.toMatchObject({
      session_id: "s1",
      has_running_task: true,
      task_info: { task_id: "r1", run_id: "r1", request_id: "req-1", status: "running", task: "hello" },
    });
  });

  it("does not query tenant data-plane repositories for a foreign session", async () => {
    const listRuns = vi.fn();
    const listOutboxForReplay = vi.fn();
    const app = new SaaSAgentReadApplication(
      "tenant-a",
      { getSession: vi.fn(async () => ({ session_id: "s1", tenant_id: "tenant-b" })) } as never,
      { listRuns } as never,
      { listOutboxForReplay } as never,
    );

    await expect(app.getSessionTaskStatus("s1")).resolves.toMatchObject({ has_running_task: false, task_info: null });
    await expect(app.listOutboxForReplay({ sessionId: "s1", afterSeq: 2 })).resolves.toEqual([]);
    expect(listRuns).not.toHaveBeenCalled();
    expect(listOutboxForReplay).not.toHaveBeenCalled();
  });

  it("maps tenant-scoped PostgreSQL runs to status, diagnostics, running tasks, and overview", async () => {
    const running = run({ run_id: "run-a", session_id: "session-a", status: "running", entrypoint: "agent_stream" });
    const completed = run({ run_id: "run-b", session_id: "session-b", status: "completed", entrypoint: "execute" });
    const getTenantRun = vi.fn(async (tenantId: string, runId: string) => tenantId === "tenant-a" && runId === "run-a" ? running : null);
    const listTenantRuns = vi.fn(async (tenantId: string, activeOnly: boolean) => {
      if (tenantId !== "tenant-a") return [];
      return activeOnly ? [running] : [running, completed];
    });
    const listRuns = vi.fn(async () => ({ total: 1, items: [running] }));
    const app = new SaaSAgentReadApplication(
      "tenant-a",
      { getSession: vi.fn(async () => ({ session_id: "session-a", tenant_id: "tenant-a" })) } as never,
      { getTenantRun, listTenantRuns, listRuns } as never,
      { listOutboxForReplay: vi.fn() } as never,
    );

    await expect(app.getTaskStatus("run-a")).resolves.toMatchObject({
      found: true, has_running_task: true, task_info: { task_id: "run-a", execution_kind: "agent_stream" },
    });
    await expect(app.getTaskExecutionDiagnostics("run-a")).resolves.toMatchObject({
      found: true, diagnostics: { is_running: true, task: { run_id: "run-a" } },
    });
    await expect(app.getTaskStatus("run-foreign")).resolves.toMatchObject({ found: false, task_info: null });
    await expect(app.getSessionExecutionDiagnostics("session-a")).resolves.toMatchObject({
      found: true, scope: "session_id", diagnostics: { task: { task_id: "run-a" } },
    });
    await expect(app.listRunningTasks()).resolves.toMatchObject({ count: 1, items: [{ task_id: "run-a" }] });
    await expect(app.getOverview(false)).resolves.toMatchObject({
      active_only: false,
      count: 2,
      by_execution_kind: { agent_stream: 1, execute: 1 },
      by_status: { running: 1, completed: 1 },
      sessions: ["session-a", "session-b"],
    });
    expect(getTenantRun).toHaveBeenCalledWith("tenant-a", "run-a");
    expect(getTenantRun).toHaveBeenCalledWith("tenant-a", "run-foreign");
    expect(listTenantRuns).toHaveBeenCalledWith("tenant-a", true);
    expect(listTenantRuns).toHaveBeenCalledWith("tenant-a", false);
    expect(listRuns).toHaveBeenCalledWith("tenant-a", "session-a", 1);
  });
});

function run(overrides: Record<string, unknown>) {
  return {
    run_id: "run", session_id: "session", tenant_id: "tenant-a", entrypoint: "execute", status: "completed",
    task_summary: "task", request_id: "request", user_id: "user", agent_name: "agent", thread_key: "root",
    parent_run_id: null, parent_call_id: null, child_agent_id: null, final_message_id: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}
