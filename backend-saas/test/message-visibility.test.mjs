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
