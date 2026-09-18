import assert from "node:assert/strict";
import test from "node:test";
import { PostgresGoalRepository } from "../dist/adapters/saas/postgres/goal-repository.js";

const pausedRow = {
  goal_id: "96c4a67c-efbd-4f22-8036-a6524ef978c1", session_id: "session-1", objective: "完成报告",
  success_criteria: ["报告已生成"], steps: [], checkpoint: {}, progress: {}, status: "paused",
  continuation_count: 1, no_progress_count: 0, continuation_generation: 2,
  continuation_pending: false, continuation_claimed_at: null, last_progress_fingerprint: null,
  continuation_reason: "manual_paused", created_at: "2026-09-17T00:00:00.000Z", updated_at: "2026-09-17T00:00:00.000Z",
};

test("Postgres rechecks the generation after acquiring the row lock, so a concurrent pause wins", async () => {
  const writes = [];
  const executor = {
    transaction: async (operation) => operation(executor),
    query: async (sql, params) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{ ...pausedRow }] };
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
  const goals = new PostgresGoalRepository("tnt_test", executor);
  await assert.rejects(goals.update("session-1", pausedRow.goal_id, { status: "active", progress: { stale: true } }, {
    expectedGeneration: 1,
  }), /旧执行/);
  await assert.rejects(goals.restartBlocked("session-1", pausedRow.goal_id, { expectedGeneration: 1 }), /旧执行/);
  assert.deepEqual(writes, []);
});

test("Postgres rejects a tool that was aborted while waiting for the Goal lock", async () => {
  const controller = new AbortController();
  let writes = 0;
  const executor = {
    transaction: async (operation) => operation(executor),
    query: async (sql) => {
      if (sql.includes("FOR UPDATE")) {
        controller.abort(new Error("user_stop"));
        return { rows: [{ ...pausedRow }] };
      }
      writes += 1;
      return { rows: [] };
    },
  };
  const goals = new PostgresGoalRepository("tnt_test", executor);
  await assert.rejects(goals.update("session-1", pausedRow.goal_id, { status: "active" }, {
    expectedGeneration: 2, signal: controller.signal,
  }), /user_stop/);
  assert.equal(writes, 0);
});
