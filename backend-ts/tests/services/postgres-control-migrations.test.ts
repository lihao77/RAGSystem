import { describe, expect, it } from "vitest";

import {
  POSTGRES_CONTROL_LATEST_SCHEMA_VERSION,
  POSTGRES_CONTROL_MIGRATIONS,
} from "../../src/adapters/saas/postgres/control-migrations.js";

describe("PostgreSQL Control Plane migrations", () => {
  it("keeps v2 as the Bot/Widget and secret boundary", () => {
    expect(POSTGRES_CONTROL_LATEST_SCHEMA_VERSION).toBe(2);
    expect(POSTGRES_CONTROL_MIGRATIONS.map((migration) => [migration.version, migration.name])).toEqual([
      [1, "control-plane-core"],
      [2, "bot-widget-and-secret-storage"],
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
  });
});
