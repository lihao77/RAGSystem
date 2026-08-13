import assert from "node:assert/strict";
import test from "node:test";

import { POSTGRES_CONVERSATION_MIGRATIONS } from "../dist/adapters/saas/postgres/conversation-schema.js";
import { POSTGRES_RUN_MIGRATIONS } from "../dist/adapters/saas/postgres/run-schema.js";

test("PostgreSQL Team snapshot migration fails on historical sessions and adds a required column", () => {
  const migration = POSTGRES_CONVERSATION_MIGRATIONS.find(item => item.version === 7);
  assert.ok(migration);
  assert.match(migration.sql, /contains sessions without immutable Team snapshots/);
  assert.match(migration.sql, /ALTER TABLE conversation_sessions ADD COLUMN team_snapshot JSONB NOT NULL/);
});

test("PostgreSQL adds a forward compensation migration for missing Run message boundaries", () => {
  const dropLink = POSTGRES_RUN_MIGRATIONS.find(item => item.version === 8);
  const createBoundaries = POSTGRES_RUN_MIGRATIONS.find(item => item.version === 9);
  const compensation = POSTGRES_RUN_MIGRATIONS.find(item => item.version === 10);
  assert.equal(dropLink?.name, "remove-run-step-message-link");
  assert.match(dropLink.sql, /DROP COLUMN IF EXISTS message_id/);
  assert.equal(createBoundaries?.name, "run-step-order-and-message-boundaries");
  assert.match(createBoundaries.sql, /CREATE TABLE IF NOT EXISTS saas_run_message_boundaries/);
  assert.equal(compensation?.name, "backfill-canonical-run-message-boundaries");
  assert.match(compensation.sql, /JOIN LATERAL/);
  assert.match(compensation.sql, /ORDER BY message.seq ASC/);
  assert.match(compensation.sql, /WHERE NOT EXISTS/);
});
