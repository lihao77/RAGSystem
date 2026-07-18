import { describe, expect, it } from "vitest";

import {
  getPendingPostgresMemoryMigrations,
  getPostgresMemoryMigrationSql,
  POSTGRES_MEMORY_LATEST_SCHEMA_VERSION,
  POSTGRES_MEMORY_MIGRATIONS,
} from "../../src/adapters/saas/postgres/memory-schema.js";

describe("PostgreSQL memory schema", () => {
  it("has immutable contiguous migrations", () => {
    expect(POSTGRES_MEMORY_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2]);
    expect(POSTGRES_MEMORY_LATEST_SCHEMA_VERSION).toBe(2);
    expect(getPendingPostgresMemoryMigrations(1).map((migration) => migration.name)).toEqual(["memory-candidates"]);
  });

  it("keeps tenant in identities, foreign keys, and query indexes", () => {
    const sql = getPostgresMemoryMigrationSql().toLowerCase();
    expect(sql).toContain("primary key (tenant_id, id)");
    expect(sql).toContain("foreign key (tenant_id, target_memory_id)");
    expect(sql).toContain("foreign key (tenant_id, published_memory_id)");
    expect(sql).toContain("on memory_entries (tenant_id, scope, scope_id");
    expect(sql).toContain("on memory_candidates (tenant_id, scope, scope_id");
  });

  it("contains approval state, optimistic version, and publish/archive guards", () => {
    const sql = getPostgresMemoryMigrationSql().toLowerCase();
    for (const column of ["reviewer_user_id", "review_comment", "reviewed_at", "published_memory_id", "version"]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("operation in ('publish', 'archive')");
    expect(sql).toContain("status in ('candidate', 'approved', 'rejected', 'withdrawn')");
    expect(sql).toContain("memory_scope_revisions");
  });

  it("rejects invalid migration cursors", () => {
    expect(() => getPendingPostgresMemoryMigrations(-1)).toThrow();
    expect(() => getPendingPostgresMemoryMigrations(1.5)).toThrow();
  });
});
