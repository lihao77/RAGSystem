import { describe, expect, it } from "vitest";
import { POSTGRES_ARTIFACT_MIGRATIONS } from "../../../../src/adapters/saas/postgres/artifact-schema.js";
import { PostgresArtifactMetadataRepository } from "../../../../src/adapters/saas/postgres/artifact-repository.js";

describe("Postgres artifact metadata", () => {
  it("defines tenant-scoped metadata and keeps blob as a path reference", () => {
    expect(POSTGRES_ARTIFACT_MIGRATIONS[0]?.sql).toContain("artifact_metadata");
    expect(POSTGRES_ARTIFACT_MIGRATIONS[0]?.sql).toContain("PRIMARY KEY (tenant_id, artifact_id)");
    expect(POSTGRES_ARTIFACT_MIGRATIONS[0]?.sql).toContain("file_path TEXT NOT NULL");
  });

  it("supports async create, list, update and delete", async () => {
    const rows: Record<string, unknown>[] = [];
    const executor = { query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith("INSERT")) {
        const row = { tenant_id: params[0], artifact_id: params[1], session_id: params[2], viz_type: params[3], sub_type: params[4], title: params[5], version: params[6], file_path: params[7], artifact_type: params[8], mime_type: params[9], config: params[10] ? JSON.parse(String(params[10])) : null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
        rows.push(row); return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith("SELECT")) return { rows: rows.filter((r) => r.tenant_id === params[0] && (!sql.includes("AND artifact_id") || r.artifact_id === params[1])) };
      if (sql.startsWith("UPDATE")) { const row = rows.find((r) => r.tenant_id === params[2] && r.artifact_id === params[3]); if (row) { row.version = params[0]; if (params[1]) row.config = JSON.parse(String(params[1])); } return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }; }
      if (sql.startsWith("DELETE")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }, transaction: async <T>(fn: (tx: typeof executor) => Promise<T>): Promise<T> => fn(executor)
    };
    const repo = new PostgresArtifactMetadataRepository(executor);
    const artifact = await repo.create({ tenant_id: "t1", artifact_id: "a1", session_id: "s1", viz_type: "chart", sub_type: "bar", title: "Sales", version: 1, file_path: "sessions/s1/a1.json", artifact_type: "json", mime_type: "application/json", config: { x: 1 } });
    expect(artifact).toMatchObject({ tenant_id: "t1", artifact_id: "a1", file_path: "sessions/s1/a1.json" });
    expect((await repo.list("t1", "s1"))).toHaveLength(1);
    expect(await repo.updateVersion("t1", "a1", 2, { x: 2 })).toMatchObject({ version: 2 });
    expect(await repo.delete("t1", "a1")).toBe(true);
  });
});
