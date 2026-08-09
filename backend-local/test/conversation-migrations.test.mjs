import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runMigrations } from "../dist/adapters/local/sqlite/conversation-store/migrations.js";
import { BASELINE_SCHEMA_SQL } from "../dist/adapters/local/sqlite/conversation-store/schema.js";

const withoutTeamSnapshot = sql => sql.replace("      team_snapshot TEXT NOT NULL,\n", "");

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
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 12);
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
