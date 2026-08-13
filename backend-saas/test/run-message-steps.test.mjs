import assert from "node:assert/strict";
import test from "node:test";

import { PostgresRunRepository } from "../dist/adapters/saas/postgres/run-repository.js";

test("message run steps continue through the terminal boundary and terminal messages own no steps", async () => {
  const queries = [];
  const executor = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/SELECT start_after_step_order, boundary_kind/.test(sql)) {
        return {
          rows: [{
            start_after_step_order: params[3] === "assistant-final" ? 16 : 10,
            boundary_kind: params[3] === "assistant-final" ? "terminal" : "carrier",
          }],
          rowCount: 1,
        };
      }
      if (/SELECT MIN\(start_after_step_order\) AS end_order/.test(sql)) {
        return { rows: [{ end_order: null }], rowCount: 1 };
      }
      if (/SELECT COUNT\(\*\)::text AS total/.test(sql)) {
        return { rows: [{ total: "2" }], rowCount: 1 };
      }
      if (/SELECT step\.id/.test(sql)) {
        const eventTypes = ["agent_ended", "run_ended"];
        return {
          rows: eventTypes.map((type, index) => ({
            id: index + 1,
            run_id: "run-1",
            session_id: "session-1",
            event_id: `event-${index + 1}`,
            step_order: index + 16,
            step_type: "protocol.envelope.v1",
            payload: { type },
            created_at: "2026-08-13T00:00:00.000Z",
          })),
          rowCount: eventTypes.length,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async transaction(fn) {
      return fn(this);
    },
  };
  const repository = new PostgresRunRepository(executor);

  const carrier = await repository.listMessageRunSteps({
    tenantId: "tnt_test",
    sessionId: "session-1",
    runId: "run-1",
    messageId: "followup-1",
    limit: 50,
    offset: 0,
  });

  assert.equal(carrier.total, 2);
  assert.deepEqual(carrier.items.map(step => step.payload.type), [
    "agent_ended",
    "run_ended",
  ]);
  const carrierSql = queries.map(item => item.sql).join("\n");
  assert.match(carrierSql, /boundary_kind='carrier' AND start_after_step_order>\$4/);
  assert.match(carrierSql, /boundary\.boundary_kind='carrier'/);

  const queryCount = queries.length;
  const terminal = await repository.listMessageRunSteps({
    tenantId: "tnt_test",
    sessionId: "session-1",
    runId: "run-1",
    messageId: "assistant-final",
    limit: 50,
    offset: 0,
  });

  assert.deepEqual(terminal, { items: [], total: 0 });
  assert.equal(queries.length, queryCount + 1);
});
