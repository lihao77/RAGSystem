import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { BASELINE_SCHEMA_SQL } from "../../src/adapters/local/sqlite/conversation-store/schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "../../src/adapters/local/sqlite/conversation-store/migrations.js";

const requireModule = createRequire(import.meta.url);
const sqlite = requireModule("node:sqlite") as typeof import("node:sqlite");

const v5 = MIGRATIONS.find((migration) => migration.version === 5)!;

describe("migration v5 execution_envelope_only", () => {
  it("deletes legacy execution steps and preserves archived envelopes", () => {
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(BASELINE_SCHEMA_SQL);
    db.prepare("INSERT INTO sessions(session_id) VALUES (?)").run("s1");
    db.prepare(`
      INSERT INTO messages(id, session_id, role, content, metadata)
      VALUES (?, ?, 'assistant', 'answer', ?)
    `).run("m1", "s1", JSON.stringify({ run_id: "run-1" }));
    const insert = db.prepare(`
      INSERT INTO run_steps(run_id, session_id, step_order, step_type, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run("run-1", "s1", 1, "execution.step", JSON.stringify({ kind: "tool" }));
    insert.run("run-1", "s1", 2, "protocol.envelope.v1", JSON.stringify({ type: "tool_call" }));

    v5.up(db);

    const rows = db.prepare("SELECT step_type, payload FROM run_steps ORDER BY step_order").all() as Array<{
      step_type: string;
      payload: string;
    }>;
    expect(rows).toEqual([
      { step_type: "protocol.envelope.v1", payload: JSON.stringify({ type: "tool_call" }) },
    ]);
    const message = db.prepare("SELECT metadata FROM messages WHERE id = 'm1'").get() as { metadata: string };
    expect(JSON.parse(message.metadata)).toEqual({ run_id: "run-1" });
    db.close();
  });

  it("marks messages whose legacy execution history was discarded", () => {
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(BASELINE_SCHEMA_SQL);
    db.prepare("INSERT INTO sessions(session_id) VALUES (?)").run("s1");
    db.prepare(`
      INSERT INTO messages(id, session_id, role, content, metadata)
      VALUES (?, ?, 'assistant', 'answer', ?)
    `).run("m1", "s1", JSON.stringify({ run_id: "legacy-run" }));
    db.prepare(`
      INSERT INTO run_steps(run_id, session_id, step_order, step_type, payload)
      VALUES ('legacy-run', 's1', 1, 'execution.step', '{}')
    `).run();

    v5.up(db);

    const message = db.prepare("SELECT metadata FROM messages WHERE id = 'm1'").get() as { metadata: string };
    expect(JSON.parse(message.metadata)).toEqual({
      run_id: "legacy-run",
      execution_history_discarded: true,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM run_steps").get()).toEqual({ count: 0 });
    db.close();
  });
});

describe("migration v6 runs_request_id", () => {
  it("adds request_id to runs through the migration chain", () => {
    const db = new sqlite.DatabaseSync(":memory:");

    runMigrations(db);
    db.prepare("INSERT INTO sessions(session_id) VALUES (?)").run("s1");
    db.prepare("INSERT INTO runs(run_id, session_id, request_id) VALUES (?, ?, ?)").run("r1", "s1", "req-1");

    expect(db.prepare("SELECT request_id FROM runs WHERE run_id = ?").get("r1")).toEqual({ request_id: "req-1" });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: LATEST_SCHEMA_VERSION });
    db.close();
  });
});
