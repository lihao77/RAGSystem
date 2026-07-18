import { describe, expect, it } from "vitest";
import { POSTGRES_KNOWLEDGE_FILE_MIGRATIONS } from "../../../../src/adapters/saas/postgres/knowledge-file-schema.js";
import { PostgresKnowledgeFileMetadataRepository } from "../../../../src/adapters/saas/postgres/knowledge-file-repository.js";

describe("Postgres knowledge file metadata", () => {
  it("defines tenant-scoped metadata schema", () => {
    expect(POSTGRES_KNOWLEDGE_FILE_MIGRATIONS[0]?.sql).toContain("knowledge_files");
    expect(POSTGRES_KNOWLEDGE_FILE_MIGRATIONS[0]?.sql).toContain("PRIMARY KEY (tenant_id, id)");
  });

  it("writes and updates metadata through the async port", async () => {
    const rows: Record<string, unknown>[] = [];
    const executor = { query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith("INSERT")) { const row = { tenant_id: params[0], id: params[1], original_name: params[2], stored_name: params[3], stored_path: params[4], size: params[5], mime: params[6], uploaded_at: "2026-01-01T00:00:00Z", md_blob_hash: params[8] }; rows.push(row); return { rows: [row], rowCount: 1 }; }
      if (sql.startsWith("SELECT")) return { rows: rows.filter((r) => r.tenant_id === params[0] && (!sql.includes("AND id") || r.id === params[1])) };
      if (sql.startsWith("UPDATE")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    } };
    const repo = new PostgresKnowledgeFileMetadataRepository(executor);
    const file = await repo.create({ tenant_id: "t1", id: "f1", original_name: "a.txt", stored_name: "x", stored_path: "/uploads/x", size: 3, mime: "text/plain" });
    expect(file).toMatchObject({ tenant_id: "t1", id: "f1", size: 3 });
    expect(await repo.get("t1", "f1")).not.toBeNull();
    expect(await repo.setMarkdownHash("t1", "f1", "abc")).toBe(true);
  });
});
