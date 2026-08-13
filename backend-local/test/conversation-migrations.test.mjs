import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runMigrations, LATEST_SCHEMA_VERSION } from "../dist/adapters/local/sqlite/conversation-store/migrations.js";
import { BASELINE_SCHEMA_SQL } from "../dist/adapters/local/sqlite/conversation-store/schema.js";

const withoutTeamSnapshot = sql => sql.replace("      team_snapshot TEXT NOT NULL,\n", "");
const withoutMailboxInputEnvelope = sql => sql
  .replace("      input_type TEXT NOT NULL DEFAULT 'agent_message'\n        CHECK(input_type IN ('user_message', 'agent_message', 'system_notification', 'goal_continuation')),\n", "")
  .replace("      source_kind TEXT NOT NULL DEFAULT 'agent'\n        CHECK(source_kind IN ('user', 'agent', 'system')),\n", "")
  .replace("      visible_to_user INTEGER NOT NULL DEFAULT 0 CHECK(visible_to_user IN (0, 1)),\n", "")
  .replace("      sent_at TEXT,\n", "");

const withLegacyCancelKind = sql => sql
  .replace("CHECK(kind IN ('progress', 'request', 'response', 'result'))", "CHECK(kind IN ('progress', 'request', 'response', 'result', 'cancel'))");

const withoutRunStepBoundaries = sql => sql
  .replace("      next_step_order INTEGER NOT NULL DEFAULT 1,\n", "")
  .replace(/    CREATE TABLE IF NOT EXISTS run_message_boundaries \([\s\S]*?\n    \);\n\n/, "")
  .replace(
    "    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_steps_session_run_order ON run_steps(session_id, run_id, step_order);",
    "    CREATE INDEX IF NOT EXISTS idx_run_steps_session_run ON run_steps(session_id, run_id);",
  )
  .replace(/    CREATE INDEX IF NOT EXISTS idx_run_message_boundaries_order\n      ON run_message_boundaries\(session_id, run_id, start_after_step_order\);\n/, "");

const withLegacyRunStepMessageLinks = sql => withoutRunStepBoundaries(sql).replace(
  /(CREATE TABLE IF NOT EXISTS run_steps \{?[\s\S]*?      session_id TEXT NOT NULL,\n)/,
  "$1      message_id TEXT,\n",
).replace("CREATE TABLE IF NOT EXISTS run_steps {", "CREATE TABLE IF NOT EXISTS run_steps (");

test("conversation migration refuses historical sessions without a Team snapshot", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutTeamSnapshot(BASELINE_SCHEMA_SQL));
    db.exec("PRAGMA user_version = 11");
    db.prepare(`
      INSERT INTO sessions (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel
      ) VALUES (?, ?, ?, 'private', 'direct', 'web')
    `).run("session-1", "tnt_test", "usr_test");

    assert.throws(
      () => runMigrations(db),
      /sessions without immutable Team snapshots/,
    );
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 11);
    assert.equal(
      db.prepare("PRAGMA table_info(sessions)").all().some(column => column.name === "team_snapshot"),
      false,
    );
  } finally {
    db.close();
  }
});

test("empty historical conversation databases receive a required Team snapshot column", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutTeamSnapshot(BASELINE_SCHEMA_SQL));
    db.exec("PRAGMA user_version = 11");

    runMigrations(db);

    const column = db.prepare("PRAGMA table_info(sessions)").all().find(item => item.name === "team_snapshot");
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
    assert.equal(column?.notnull, 1);
    assert.equal(column?.dflt_value, null);
  } finally {
    db.close();
  }
});

test("fresh conversation schema requires immutable Team snapshots", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BASELINE_SCHEMA_SQL);
    const column = db.prepare("PRAGMA table_info(sessions)").all().find(item => item.name === "team_snapshot");
    assert.equal(column?.notnull, 1);
  } finally {
    db.close();
  }
});

test("v12 conversation databases receive Agent mailbox input envelope defaults", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutMailboxInputEnvelope(BASELINE_SCHEMA_SQL));
    db.exec("PRAGMA user_version = 12");
    db.prepare(`
      INSERT INTO sessions (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel, team_snapshot
      ) VALUES (?, ?, ?, 'private', 'direct', 'web', ?)
    `).run("session-1", "tnt_test", "usr_test", "{}");
    db.prepare(`
      INSERT INTO agent_mailbox (
        message_id, tenant_id, session_id, target_thread_key, kind
      ) VALUES (?, ?, ?, ?, ?)
    `).run("message-1", "tnt_test", "session-1", "root", "request");

    runMigrations(db);

    const message = db.prepare(`
      SELECT input_type, source_kind, visible_to_user, sent_at
      FROM agent_mailbox WHERE message_id = ?
    `).get("message-1");
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
    assert.equal(message.input_type, "agent_message");
    assert.equal(message.source_kind, "agent");
    assert.equal(message.visible_to_user, 0);
    assert.equal(message.sent_at, null);
  } finally {
    db.close();
  }
});

test("v14 mailbox drops legacy cancel kind and tightens the CHECK constraint", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withLegacyCancelKind(BASELINE_SCHEMA_SQL));
    db.exec("PRAGMA user_version = 14");
    db.prepare(`
      INSERT INTO sessions (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel, team_snapshot
      ) VALUES (?, ?, ?, 'private', 'direct', 'web', ?)
    `).run("session-1", "tnt_test", "usr_test", "{}");
    db.prepare(`
      INSERT INTO agent_mailbox (message_id, tenant_id, session_id, target_thread_key, kind)
      VALUES (?, ?, ?, ?, ?)
    `).run("cancel-1", "tnt_test", "session-1", "root", "cancel");
    db.prepare(`
      INSERT INTO agent_mailbox (message_id, tenant_id, session_id, target_thread_key, kind)
      VALUES (?, ?, ?, ?, ?)
    `).run("request-1", "tnt_test", "session-1", "root", "request");

    runMigrations(db);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_mailbox WHERE kind='cancel'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_mailbox WHERE message_id='request-1'").get().count, 1);
    assert.throws(
      () => db.prepare(`
        INSERT INTO agent_mailbox (message_id, tenant_id, session_id, target_thread_key, kind)
        VALUES (?, ?, ?, ?, ?)
      `).run("cancel-2", "tnt_test", "session-1", "root", "cancel"),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test("v13 pending user messages migrate idempotently to root mailbox", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BASELINE_SCHEMA_SQL);
    db.exec("PRAGMA user_version = 13");
    db.prepare(`
      INSERT INTO sessions (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel, team_snapshot
      ) VALUES (?, ?, ?, 'private', 'direct', 'web', ?)
    `).run("session-1", "tnt_test", "usr_test", "{}");
    db.prepare(`
      INSERT INTO messages (id, session_id, role, content, content_parts, metadata, thread_key)
      VALUES (?, ?, 'user', ?, ?, ?, 'root')
    `).run("pending-1", "session-1", "follow up", '[{"type":"text","text":"follow up"}]', '{"followup_pending":true,"request_id":"req-1"}');

    runMigrations(db);
    runMigrations(db);

    const mailbox = db.prepare("SELECT * FROM agent_mailbox WHERE message_id=?").all("pending-1");
    assert.equal(mailbox.length, 1);
    assert.equal(mailbox[0].input_type, "user_message");
    assert.equal(mailbox[0].source_kind, "user");
    assert.equal(mailbox[0].visible_to_user, 1);
    assert.equal(mailbox[0].target_thread_key, "root");
    const message = db.prepare("SELECT metadata FROM messages WHERE id=?").get("pending-1");
    assert.equal(JSON.parse(message.metadata).followup_pending, undefined);
  } finally {
    db.close();
  }
});

test("v16 run steps receive durable per-run ordering and message boundaries", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withoutRunStepBoundaries(BASELINE_SCHEMA_SQL));
    db.exec("PRAGMA user_version = 16");
    db.prepare(`
      INSERT INTO sessions (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel, team_snapshot
      ) VALUES (?, ?, ?, 'private', 'direct', 'web', ?)
    `).run("session-1", "tnt_test", "usr_test", "{}");
    db.prepare(`
      INSERT INTO runs (
        run_id, session_id, tenant_id, status, agent_call_id,
        agent_display_name, lease_root_run_id, thread_key
      ) VALUES (?, ?, ?, 'completed', ?, ?, ?, 'root')
    `).run("root-run", "session-1", "tnt_test", "root-call", "assistant", "root-run");
    const insertStep = db.prepare(`
      INSERT INTO run_steps (run_id, session_id, event_id, step_order, step_type, payload)
      VALUES (?, ?, ?, ?, 'protocol.envelope.v1', '{}')
    `);
    insertStep.run("root-run", "session-1", "event-1", 1);
    insertStep.run("root-run", "session-1", "event-2", 2);

    runMigrations(db);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT next_step_order FROM runs WHERE run_id='root-run'").get().next_step_order, 3);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_message_boundaries'").get().name,
      "run_message_boundaries",
    );
    const index = db.prepare("PRAGMA index_list(run_steps)").all()
      .find(item => item.name === "idx_run_steps_session_run_order");
    assert.equal(index?.unique, 1);
  } finally {
    db.close();
  }
});

test("legacy SQLite run step message links are backfilled before the column is dropped", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(withLegacyRunStepMessageLinks(BASELINE_SCHEMA_SQL));
    db.exec("PRAGMA user_version = 15");
    db.prepare(`INSERT INTO sessions (
      session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel, team_snapshot
    ) VALUES (?, ?, ?, 'private', 'direct', 'web', ?)`)
      .run("session-legacy", "tnt_test", "usr_test", "{}");
    db.prepare(`INSERT INTO runs (
      run_id, session_id, tenant_id, status, agent_call_id,
      agent_display_name, lease_root_run_id, thread_key
    ) VALUES (?, ?, ?, 'completed', ?, ?, ?, 'root')`)
      .run("legacy-run", "session-legacy", "tnt_test", "legacy-call", "assistant", "legacy-run");
    db.prepare(`INSERT INTO messages (
      id, session_id, role, content, content_parts, metadata, thread_key
    ) VALUES (?, ?, 'assistant', 'done', '[]', ?, 'root')`)
      .run("legacy-message", "session-legacy", '{"run_id":"legacy-run"}');
    db.prepare(`INSERT INTO run_steps (
      run_id, session_id, message_id, event_id, step_order, step_type, payload
    ) VALUES (?, ?, ?, ?, 1, 'protocol.envelope.v1', '{}')`)
      .run("legacy-run", "session-legacy", "legacy-message", "legacy-event");

    runMigrations(db);

    assert.equal(db.prepare("PRAGMA table_info(run_steps)").all().some(column => column.name === "message_id"), false);
    const boundary = db.prepare(`SELECT message_id, start_after_step_order, boundary_step_order, boundary_kind
      FROM run_message_boundaries WHERE session_id='session-legacy' AND run_id='legacy-run'`).get();
    assert.equal(boundary.message_id, "legacy-message");
    assert.equal(boundary.start_after_step_order, 0);
    assert.equal(boundary.boundary_step_order, null);
    assert.equal(boundary.boundary_kind, "carrier");
  } finally {
    db.close();
  }
});

test("v17 SQLite databases compensate missing boundaries from canonical Run messages", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BASELINE_SCHEMA_SQL);
    db.exec("PRAGMA user_version = 17");
    db.prepare(`INSERT INTO sessions (
      session_id, tenant_id, owner_user_id, visibility, origin_type, origin_channel, team_snapshot
    ) VALUES (?, ?, ?, 'private', 'direct', 'web', ?)`)
      .run("session-v17", "tnt_test", "usr_test", "{}");
    db.prepare(`INSERT INTO runs (
      run_id, session_id, tenant_id, status, agent_call_id,
      agent_display_name, lease_root_run_id, thread_key
    ) VALUES (?, ?, ?, 'completed', ?, ?, ?, 'root')`)
      .run("v17-run", "session-v17", "tnt_test", "v17-call", "assistant", "v17-run");
    db.prepare(`INSERT INTO messages (
      id, session_id, role, content, content_parts, metadata, thread_key
    ) VALUES (?, ?, 'user', 'start', '[]', ?, 'root')`)
      .run("v17-message", "session-v17", '{"run_id":"v17-run"}');

    runMigrations(db);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
    assert.equal(
      db.prepare("SELECT message_id FROM run_message_boundaries WHERE run_id='v17-run'").get().message_id,
      "v17-message",
    );
  } finally {
    db.close();
  }
});
