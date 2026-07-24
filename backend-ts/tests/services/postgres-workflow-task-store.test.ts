import { describe, expect, it } from "vitest";

import { runPostgresWorkflowTaskMigrations } from "../../src/adapters/saas/postgres/workflow-task-migrations.js";
import { PostgresWorkflowTaskRepository } from "../../src/adapters/saas/postgres/workflow-task-repository.js";
import type {
  PostgresMemoryExecutor,
  PostgresQueryResult,
} from "../../src/adapters/saas/postgres/memory-repository.js";
import { createTenantId } from "../../src/identity/types.js";

interface FakeWorkflowTaskRow extends Record<string, unknown> {
  task_id: string;
  subject: string;
  description: string;
  active_form: string;
  owner: string;
  status: string;
  blocks: string[];
  blocked_by: string[];
  metadata: Record<string, unknown>;
}

class CapturingExecutor implements PostgresMemoryExecutor {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  transactions = 0;
  private readonly tasks = new Map<string, FakeWorkflowTaskRow>();
  private nextTaskId = 1;

  constructor(private readonly migrationHistory: Record<string, unknown>[] = []) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, ...(params == null ? {} : { params }) });
    if (sql.includes("SELECT version,name FROM ragsystem_workflow_task_schema_migrations")) {
      return { rows: this.migrationHistory as Row[] };
    }
    if (sql.includes("INSERT INTO workflow_tasks")) {
      const taskId = String(this.nextTaskId++);
      const row: FakeWorkflowTaskRow = {
        task_id: taskId,
        subject: String(params?.[2] ?? ""),
        description: String(params?.[3] ?? ""),
        active_form: String(params?.[4] ?? ""),
        owner: "",
        status: "pending",
        blocks: [],
        blocked_by: [],
        metadata: JSON.parse(String(params?.[5] ?? "{}")) as Record<string, unknown>,
      };
      this.tasks.set(taskId, row);
      return {
        rows: [cloneRow(row) as unknown as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("task_id = ANY($3::bigint[])") && sql.includes("FOR UPDATE")) {
      const ids = Array.isArray(params?.[2]) ? params[2].map(String) : [];
      return { rows: ids.flatMap((id) => {
        const row = this.tasks.get(id);
        return row ? [cloneRow(row) as unknown as Row] : [];
      }) };
    }
    if (sql.includes("ORDER BY task_id FOR UPDATE")) {
      return { rows: this.listRows() as unknown as Row[] };
    }
    if (sql.includes("SET subject=$1")) {
      const taskId = String(params?.[10] ?? "");
      const row = this.tasks.get(taskId);
      if (!row) return { rows: [], rowCount: 0 };
      this.tasks.set(taskId, {
        ...row,
        subject: String(params?.[0] ?? ""),
        description: String(params?.[1] ?? ""),
        active_form: String(params?.[2] ?? ""),
        owner: String(params?.[3] ?? ""),
        status: String(params?.[4] ?? "pending"),
        blocks: JSON.parse(String(params?.[5] ?? "[]")) as string[],
        blocked_by: JSON.parse(String(params?.[6] ?? "[]")) as string[],
        metadata: JSON.parse(String(params?.[7] ?? "{}")) as Record<string, unknown>,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET blocks=$1::jsonb")) {
      const taskId = String(params?.[4] ?? "");
      const row = this.tasks.get(taskId);
      if (!row) return { rows: [], rowCount: 0 };
      this.tasks.set(taskId, {
        ...row,
        blocks: JSON.parse(String(params?.[0] ?? "[]")) as string[],
        blocked_by: JSON.parse(String(params?.[1] ?? "[]")) as string[],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM workflow_tasks")) {
      const deleted = this.tasks.delete(String(params?.[2] ?? ""));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    if (sql.includes("task_id=$3::bigint")) {
      const row = this.tasks.get(String(params?.[2] ?? ""));
      return { rows: row ? [cloneRow(row) as unknown as Row] : [] };
    }
    if (sql.includes("FROM workflow_tasks") && sql.includes("ORDER BY task_id ASC")) {
      return { rows: this.listRows() as unknown as Row[] };
    }
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn(this);
  }

  private listRows(): FakeWorkflowTaskRow[] {
    return [...this.tasks.values()]
      .sort((left, right) => Number(left.task_id) - Number(right.task_id))
      .map(cloneRow);
  }
}

function cloneRow(row: FakeWorkflowTaskRow): FakeWorkflowTaskRow {
  return {
    ...row,
    blocks: [...row.blocks],
    blocked_by: [...row.blocked_by],
    metadata: { ...row.metadata },
  };
}

describe("PostgreSQL workflow task persistence", () => {
  it("creates the tenant/session-scoped table through the migration runner", async () => {
    const executor = new CapturingExecutor();

    await expect(runPostgresWorkflowTaskMigrations(executor)).resolves.toEqual({
      current_version: 1,
      applied_versions: [1],
    });

    expect(executor.transactions).toBe(1);
    expect(executor.calls[0]?.sql).toBe("SELECT pg_advisory_xact_lock($1)");
    const ddl = executor.calls.find((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS workflow_tasks"))?.sql;
    expect(ddl).toContain("PRIMARY KEY (tenant_id, task_id)");
    expect(ddl).toContain("FOREIGN KEY (tenant_id, session_id)");
    expect(ddl).toContain("ON DELETE CASCADE");
  });

  it("binds every repository operation to its tenant and session", async () => {
    const executor = new CapturingExecutor();
    const repository = new PostgresWorkflowTaskRepository(createTenantId("tnt_tenant_a"), executor);

    const blocker = await repository.create("session-a", {
      subject: "Prepare",
      description: "Prepare inputs",
      metadata: { source: "test" },
    });
    const blocked = await repository.create("session-a", {
      subject: "Execute",
      description: "Run workflow",
    });
    const downstream = await repository.create("session-a", {
      subject: "Publish",
      description: "Publish results",
    });
    await expect(repository.update("session-a", blocked.id, {
      owner: "agent-a",
      addBlockedBy: [blocker.id],
      addBlocks: [downstream.id],
    })).resolves.toMatchObject({
      id: blocked.id,
      owner: "agent-a",
      blocked_by: [blocker.id],
      blocks: [downstream.id],
    });
    await expect(repository.get("session-a", blocker.id)).resolves.toMatchObject({ blocks: [blocked.id] });
    await expect(repository.get("session-a", downstream.id)).resolves.toMatchObject({ blocked_by: [blocked.id] });
    await expect(repository.delete("session-a", blocked.id)).resolves.toBe(true);
    await expect(repository.get("session-a", blocker.id)).resolves.toMatchObject({ blocks: [] });
    await expect(repository.get("session-a", downstream.id)).resolves.toMatchObject({ blocked_by: [] });
    await expect(repository.list("session-a")).resolves.toHaveLength(2);

    const createCalls = executor.calls.filter((call) => call.sql.includes("INSERT INTO workflow_tasks"));
    expect(createCalls).toHaveLength(3);
    expect(createCalls.every((call) => call.params?.[0] === "tnt_tenant_a" && call.params?.[1] === "session-a"))
      .toBe(true);

    const scopedCalls = executor.calls.filter((call) =>
      call.sql.includes("FROM workflow_tasks") || call.sql.startsWith("DELETE FROM workflow_tasks"),
    );
    for (const call of scopedCalls) {
      expect(call.sql).toContain("tenant_id=$1");
      expect(call.sql).toContain("session_id=$2");
      expect(call.params?.slice(0, 2)).toEqual(["tnt_tenant_a", "session-a"]);
    }

    const aggregateUpdates = executor.calls.filter((call) => call.sql.includes("SET subject=$1"));
    expect(aggregateUpdates.length).toBeGreaterThanOrEqual(2);
    for (const call of aggregateUpdates) {
      expect(call.sql).toContain("tenant_id=$9");
      expect(call.sql).toContain("session_id=$10");
      expect(call.params?.slice(8, 10)).toEqual(["tnt_tenant_a", "session-a"]);
    }

    const cleanupUpdates = executor.calls.filter((call) => call.sql.includes("SET blocks=$1::jsonb"));
    expect(cleanupUpdates).toHaveLength(2);
    for (const call of cleanupUpdates) {
      expect(call.sql).toContain("tenant_id=$3");
      expect(call.sql).toContain("session_id=$4");
      expect(call.params?.slice(2, 4)).toEqual(["tnt_tenant_a", "session-a"]);
    }
  });

  it("rejects divergent migration history before applying task DDL", async () => {
    const executor = new CapturingExecutor([{ version: 1, name: "renamed" }]);

    await expect(runPostgresWorkflowTaskMigrations(executor))
      .rejects.toThrow("invalid PostgreSQL workflow task migration history");
    expect(executor.calls.some((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS workflow_tasks"))).toBe(false);
  });
});
