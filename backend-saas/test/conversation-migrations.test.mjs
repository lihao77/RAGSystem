import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_CONVERSATION_MIGRATIONS } from "../dist/adapters/saas/postgres/conversation-schema.js";

test("PostgreSQL Team snapshot migration fails on historical sessions and adds a required column", () => {
  const migration = POSTGRES_CONVERSATION_MIGRATIONS.find(item => item.version === 7);
  assert.ok(migration);
  assert.match(migration.sql, /contains sessions without immutable Team snapshots/);
  assert.match(migration.sql, /ALTER TABLE conversation_sessions ADD COLUMN team_snapshot JSONB NOT NULL/);
});
