import { describe, expect, it, vi } from "vitest";

import { SaaSAgentReadApplication } from "../../../src/services/runtime/saas-agent-read-application.js";

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
});
