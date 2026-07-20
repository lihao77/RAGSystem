import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  runMigrations,
} from "../../src/adapters/local/sqlite/conversation-store/migrations.js";

const requireModule = createRequire(import.meta.url);
const sqlite = requireModule("node:sqlite") as typeof import("node:sqlite");

describe("migration v16 run_step_event_idempotency", () => {
  it("preserves legacy steps and enforces one non-null event id", () => {
    const db = new sqlite.DatabaseSync(":memory:");
    try {
      for (const migration of MIGRATIONS.filter((item) => item.version <= 15)) {
        migration.up(db);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      db.prepare(`
        INSERT INTO run_steps(run_id, session_id, step_order, step_type, payload)
        VALUES (?, ?, ?, ?, ?)
      `).run("legacy-run", "legacy-session", 1, "legacy", "{}");

      runMigrations(db);

      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: LATEST_SCHEMA_VERSION });
      expect(db.prepare("SELECT event_id FROM run_steps WHERE run_id=?").get("legacy-run"))
        .toEqual({ event_id: null });
      db.prepare(`
        INSERT INTO run_steps(run_id, session_id, event_id, step_order, step_type, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("run-1", "session-1", "event-1", 1, "event", "{}");
      expect(() => db.prepare(`
        INSERT INTO run_steps(run_id, session_id, event_id, step_order, step_type, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("run-2", "session-2", "event-1", 1, "event", "{}"))
        .toThrow();
    } finally {
      db.close();
    }
  });
});
