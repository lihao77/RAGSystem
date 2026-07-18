import { describe, expect, it } from "vitest";

import { getSaasMemoryMigrations } from "../../src/adapters/saas/postgres/memory-schema.js";

describe("SaaS memory PostgreSQL schema", () => {
  it("contains ordered tenant-scoped entry, candidate, and revision migrations", () => {
    const migrations = getSaasMemoryMigrations();
    expect(migrations.map((item) => item.version)).toEqual([1, 2]);
    expect(migrations.map((item) => item.name)).toEqual([
      "memory-entries",
      "memory-candidates",
    ]);
    const sql = migrations.map((item) => item.sql).join("\n");
    expect(sql).toContain("tenant_id TEXT NOT NULL");
    expect(sql).toContain("status IN ('active', 'archived')");
    expect(sql).toContain("memory_scope_revisions");
  });

  it("returns a defensive migration list", () => {
    const first = getSaasMemoryMigrations();
    const second = getSaasMemoryMigrations();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
