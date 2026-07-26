import { describe, expect, it } from "vitest";

import {
  POSTGRES_CONTROL_LATEST_SCHEMA_VERSION,
  POSTGRES_CONTROL_MIGRATIONS,
} from "../../src/adapters/saas/postgres/control-migrations.js";

describe("PostgreSQL Control Plane migrations", () => {
  it("keeps v2 as Bot/Widget, v3 as the lease boundary, and v4 as bot team", () => {
    expect(POSTGRES_CONTROL_LATEST_SCHEMA_VERSION).toBe(4);
    expect(POSTGRES_CONTROL_MIGRATIONS.map((migration) => [migration.version, migration.name])).toEqual([
      [1, "control-plane-core"],
      [2, "bot-widget-and-secret-storage"],
      [3, "control-cron-lease"],
      [4, "control-bot-team"],
    ]);
    const sql = POSTGRES_CONTROL_MIGRATIONS[1]?.sql ?? "";
    for (const table of [
      "control_secret_envelopes",
      "control_bot_configs",
      "control_bot_cron_tasks",
      "control_widget_apps",
      "control_widget_tokens",
      "control_widget_audit",
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(sql).toContain("control_bot_configs_route_digest_idx");
    expect(sql).toContain("REFERENCES control_tenants(id) ON DELETE CASCADE");
    expect(sql).toContain("REFERENCES control_users(id) ON DELETE CASCADE");
    const leaseSql = POSTGRES_CONTROL_MIGRATIONS[2]?.sql ?? "";
    expect(leaseSql).toContain("lease_token");
    expect(leaseSql).toContain("last_attempt_id");
    expect(leaseSql).toContain("attempt_count");
    expect(leaseSql).toContain("control_bot_cron_attempt_idx");
    expect(leaseSql).not.toContain("control_import_checkpoints");
    expect(POSTGRES_CONTROL_MIGRATIONS[3]?.sql).toContain("ADD COLUMN team TEXT");
  });
});
