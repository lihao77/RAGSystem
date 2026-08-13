import assert from "node:assert/strict";
import test from "node:test";

import { PostgresConversationRepository } from "../dist/adapters/saas/postgres/conversation-repository.js";

test("visible message SQL compares JSONB flags as native booleans", async () => {
  const queries = [];
  const executor = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/COUNT\(1\)/.test(sql)) return { rows: [{ cnt: 0 }], rowCount: 1 };
      if (/COALESCE\(MAX\(seq\)/.test(sql)) return { rows: [{ watermark: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async transaction(fn) {
      return fn(this);
    },
  };
  const repository = new PostgresConversationRepository(executor);

  await repository.listVisibleMessagesSnapshot("tnt_test", "session-1", 50, 0, "root");

  const sql = queries.map(item => item.sql).join("\n");
  assert.match(sql, /metadata->'react_intermediate' IS DISTINCT FROM 'true'::jsonb/);
  assert.match(sql, /metadata->'hidden' IS DISTINCT FROM 'true'::jsonb/);
  assert.match(sql, /metadata->'visible_to_user' IS DISTINCT FROM 'false'::jsonb/);
  assert.match(sql, /metadata->'agent_message' = 'true'::jsonb/);
  assert.doesNotMatch(sql, /metadata->>'(?:react_intermediate|hidden|visible_to_user|agent_message)'/);
});

test("rollback discovers and truncates every tenant-scoped run boundary before deleting messages", async () => {
  const queries = [];
  const executor = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/MIN\(boundary\.boundary_step_order\)/.test(sql)) {
        return { rows: [
          { run_id: "root-run", from_step_order: 3 },
          { run_id: "child-run", from_step_order: 7 },
        ], rowCount: 2 };
      }
      if (/WITH deleted_runs AS/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: /DELETE FROM conversation_messages/.test(sql) ? 2 : 1 };
    },
    async transaction(fn) {
      return fn(this);
    },
  };
  const repository = new PostgresConversationRepository(executor);

  const deleted = await repository.deleteMessagesAfter("session-1", {
    afterSeq: 1,
    tenantId: "tnt_test",
  });

  assert.equal(deleted, 2);
  assert.match(queries[0].sql, /JOIN conversation_messages/);
  assert.match(queries[0].sql, /GROUP BY boundary.run_id/);
  assert.match(queries[1].sql, /WITH deleted_runs AS/);
  assert.match(queries[1].sql, /NOT EXISTS/);
  assert.deepEqual(
    queries.filter(item => /DELETE FROM saas_run_steps/.test(item.sql)).map(item => item.params),
    [
      ["tnt_test", "session-1", "root-run", 3],
      ["tnt_test", "session-1", "child-run", 7],
    ],
  );
  assert.match(queries.at(-1).sql, /DELETE FROM conversation_messages/);
  assert.deepEqual(queries.at(-1).params, ["session-1", 1]);
});
