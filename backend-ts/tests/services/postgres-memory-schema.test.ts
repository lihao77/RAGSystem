import { describe, expect, it } from "vitest";

import {
  getPendingPostgresMemoryMigrations,
  getPostgresMemoryMigrationSql,
  POSTGRES_MEMORY_LATEST_SCHEMA_VERSION,
  POSTGRES_MEMORY_MIGRATIONS,
} from "../../src/adapters/saas/postgres/memory-schema.js";

describe("PostgreSQL memory schema", () => {
  it("has immutable contiguous migrations", () => {
    expect(POSTGRES_MEMORY_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4]);
    expect(POSTGRES_MEMORY_LATEST_SCHEMA_VERSION).toBe(4);
    expect(getPendingPostgresMemoryMigrations(1).map((migration) => migration.name))
      .toEqual([
        "memory-candidates",
        "memory-candidate-review-claims",
        "publish-existing-personal-memory-candidates",
      ]);
  });

  it("adds tenant-scoped review claim columns and indexes", () => {
    const sql = POSTGRES_MEMORY_MIGRATIONS[2]?.sql.toLowerCase() ?? "";
    expect(sql).toContain("review_claim_token");
    expect(sql).toContain("review_claimed_at");
    expect(sql).toContain("(tenant_id, review_claim_token)");
  });

  it("promotes only legacy personal publish candidates and preserves their audit rows", () => {
    const sql = POSTGRES_MEMORY_MIGRATIONS[3]?.sql.toLowerCase() ?? "";
    expect(sql).toContain("scope in ('session', 'user', 'workspace')");
    expect(sql).toContain("operation = 'publish'");
    expect(sql).toContain("insert into memory_entries");
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain("published_memory_id = candidate.id");
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
