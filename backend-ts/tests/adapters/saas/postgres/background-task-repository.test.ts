import { describe, expect, it, vi } from "vitest";

import { PostgresBackgroundTaskRepository } from "../../../../src/adapters/saas/postgres/background-task-repository.js";

describe("PostgresBackgroundTaskRepository", () => {
  it("lists retained tasks with tenant and Session isolation", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [row()], rowCount: 1 }));
    const repository = new PostgresBackgroundTaskRepository({ query } as never);

    await expect(repository.listBySession("tenant-a", "session-a", 123)).resolves.toEqual([
      expect.objectContaining({
        tenant_id: "tenant-a",
        task_id: "task-a",
        session_id: "session-a",
        status: "running",
      }),
    ]);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("tenant_id = $1");
    expect(sql).toContain("session_id = $2");
    expect(sql).toContain("expires_at IS NULL OR expires_at > $3");
    expect(params).toEqual(["tenant-a", "session-a", 123]);
  });

  it("expires only running leases in the requested tenant", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [{ task_id: "stale" }], rowCount: 1 }));
    const repository = new PostgresBackgroundTaskRepository({ query } as never);

    await expect(repository.failExpiredRunning("tenant-a", 456, "lease expired")).resolves.toEqual(["stale"]);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("tenant_id = $1");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("lease_expires_at <= $2");
    expect(params).toEqual(["tenant-a", 456, "lease expired"]);
  });
});

function row(): Record<string, unknown> {
  return {
    tenant_id: "tenant-a",
    task_id: "task-a",
    description: "task",
    output_path: "output.log",
    started_at: 1,
    status: "running",
    return_code: null,
    error: null,
    expires_at: 999,
    run_id: null,
    owner_task_id: null,
    session_id: "session-a",
    completed_at: null,
    result_type: null,
    kind: "bash",
    cancel_supported: true,
    owner_instance_id: "instance-a",
    lease_expires_at: 500,
  };
}
