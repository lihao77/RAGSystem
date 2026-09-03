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

test("PostgreSQL session list title override migration preserves explicit titles on rebuild", () => {
  const migration = POSTGRES_CONVERSATION_MIGRATIONS.find(item => item.version === 12);
  assert.ok(migration);
  assert.equal(migration?.name, "session_list_title_override");
  // 列落点：LLM 生成标题持久化在投影行自身
  assert.match(migration?.sql ?? "", /ALTER TABLE conversation_session_list_projection ADD COLUMN IF NOT EXISTS title_override TEXT/);
  // 重建函数读取现有 override 并优先于首条消息截断派生
  assert.match(migration?.sql ?? "", /SELECT title_override INTO title_override_text/);
  assert.match(migration?.sql ?? "", /COALESCE\(\s*title_override_text,\s*COALESCE\(left\(btrim\(first_row\.plain_text\), 30\), ''\)\s*\)/);
  // ON CONFLICT 更新清单不得触碰 title_override（否则下一条消息的触发器重建会把显式标题冲掉）
  const conflictClause = migration?.sql ?? "";
  const updateList = conflictClause.split("ON CONFLICT (session_id) DO UPDATE SET")[1] ?? "";
  assert.doesNotMatch(updateList, /title_override\s*=/);
});
