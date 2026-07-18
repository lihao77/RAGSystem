import { describe, expect, it } from "vitest";

import { PostgresPendingInteractionRepository } from "../../../../src/adapters/saas/postgres/pending-interaction-repository.js";
import type {
  PostgresMemoryExecutor,
  PostgresQueryResult,
} from "../../../../src/adapters/saas/postgres/memory-repository.js";

const base = {
  interaction_id: "approval-1",
  session_id: "session-1",
  run_id: "run-1",
  root_run_id: "root-1",
  tool_call_id: "call-1",
  batch_id: "batch-1",
  kind: "approval",
  status: "resolved",
  request_payload: { command: "deploy" },
  resolution_payload: { approved: true },
  created_at: "2026-07-18T00:00:00.000Z",
  updated_at: "2026-07-18T00:01:00.000Z",
  responded_at: "2026-07-18T00:01:00.000Z",
  consumed_at: null,
};

class FakeExecutor implements PostgresMemoryExecutor {
  calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  selectRows: Record<string, unknown>[] = [base];
  rowCount = 1;
  transactions = 0;

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<T>> {
    this.calls.push({ sql, params });
    if (sql.trimStart().startsWith("SELECT")) {
      return { rows: this.selectRows as T[] };
    }
    return { rows: [], rowCount: this.rowCount };
  }

  async transaction<T>(operation: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return operation(this);
  }
}

describe("PostgresPendingInteractionRepository", () => {
  it("creates idempotently and maps JSON and timestamps", async () => {
    const db = new FakeExecutor();
    const record = await new PostgresPendingInteractionRepository(db).createPendingInteraction({
      interactionId: "approval-1",
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "root-1",
      toolCallId: "call-1",
      batchId: "batch-1",
      kind: "approval",
      requestPayload: { command: "deploy" },
    });

    expect(record.request_payload).toEqual({ command: "deploy" });
    expect(record.responded_at).toBe("2026-07-18T00:01:00.000Z");
    expect(db.calls[0]?.sql).toContain("ON CONFLICT(interaction_id) DO NOTHING");
  });

  it("filters list and status updates with explicit state guards", async () => {
    const db = new FakeExecutor();
    const repository = new PostgresPendingInteractionRepository(db);

    await repository.listPendingInteractions({
      sessionId: "session-1",
      rootRunId: "root-1",
      batchId: "batch-1",
      statuses: ["waiting", "suspended"],
    });
    await repository.updatePendingInteractionStatus({
      sessionId: "session-1",
      interactionId: "approval-1",
      from: ["waiting", "suspended"],
      status: "resolved",
      resolution: { approved: true },
    });

    expect(db.calls[0]?.sql).toContain("status=ANY($4::text[])");
    expect(db.calls[1]?.sql).toContain("status=ANY($6::text[])");
    expect(db.calls[1]?.sql).toContain("responded_at=CASE WHEN $1='resolved'");
  });

  it("preserves suspend, resume, release, and cancel transition contracts", async () => {
    const db = new FakeExecutor();
    const repository = new PostgresPendingInteractionRepository(db);

    await expect(repository.suspendPendingInteractions("session-1", "root-1")).resolves.toBe(1);
    await expect(repository.markPendingBatchResuming("session-1", "batch-1")).resolves.toBe(1);
    await expect(repository.releasePendingBatch("session-1", "batch-1")).resolves.toBe(1);
    await expect(repository.cancelPendingInteractions("session-1")).resolves.toBe(1);

    expect(db.calls[0]?.sql).toContain("status='waiting'");
    expect(db.calls[1]?.sql).toContain("NOT EXISTS");
    expect(db.calls[1]?.sql).toContain("unresolved.status IN ('waiting','suspended')");
    expect(db.calls[2]?.sql).toContain("status='resuming'");
    expect(db.calls[3]?.sql).toContain("status IN ('waiting','suspended','resolved','resuming')");
  });

  it("locks and consumes the latest resolved interaction atomically", async () => {
    const db = new FakeExecutor();
    const result = await new PostgresPendingInteractionRepository(db)
      .consumePendingResolution("session-1", "call-1");

    expect(result?.interaction_id).toBe("approval-1");
    expect(db.transactions).toBe(1);
    expect(db.calls[0]?.sql).toContain("status IN ('resolved','resuming')");
    expect(db.calls[0]?.sql).toContain("LIMIT 1 FOR UPDATE");
    expect(db.calls[1]?.sql).toContain("status='consumed'");
    expect(db.calls[1]?.sql).toContain("consumed_at=CURRENT_TIMESTAMP");
  });
});
