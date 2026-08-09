import assert from "node:assert/strict";
import test from "node:test";

import { PostgresChildAgentRepository } from "../dist/adapters/saas/postgres/child-agent-repository.js";

test("SaaS child participant latest Run update uses a null-safe CAS predicate", async () => {
  const queries = [];
  const executor = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
    async transaction(fn) {
      return fn(this);
    },
  };
  const repository = new PostgresChildAgentRepository(executor);

  const updated = await repository.updateChildAgentLastRun("tnt_test", {
    sessionId: "session-1",
    childAgentId: "child-1",
    lastRunId: "run-b",
    expectedLastRunId: "run-a",
  });

  assert.equal(updated, true);
  assert.match(queries[0].sql, /last_run_id IS NOT DISTINCT FROM \$5/);
  assert.deepEqual(queries[0].params, ["run-b", "tnt_test", "session-1", "child-1", "run-a"]);
});
