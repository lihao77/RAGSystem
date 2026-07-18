import { describe, expect, it } from "vitest";
import { POSTGRES_VECTOR_INDEX_MIGRATIONS } from "../../../../src/adapters/saas/postgres/vector-index-schema.js";
import { PostgresKnowledgeVectorIndexRepository } from "../../../../src/adapters/saas/postgres/vector-index-repository.js";

describe("Postgres knowledge vector index metadata", () => {
  it("defines tenant-scoped index state", () => {
    expect(POSTGRES_VECTOR_INDEX_MIGRATIONS[0]?.sql).toContain("knowledge_vector_index");
    expect(POSTGRES_VECTOR_INDEX_MIGRATIONS[0]?.sql).toContain("PRIMARY KEY (tenant_id, collection, document_id, model_id)");
  });

  it("upserts and lists document index state", async () => {
    const rows: Record<string, unknown>[] = [];
    const executor = { query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith("INSERT")) {
        const row = { tenant_id: params[0], collection: params[1], document_id: params[2], model_id: params[3], chunk_count: params[4], embedding_dimension: params[5], status: params[6], error_message: params[7], indexed_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
        rows.push(row); return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith("SELECT")) return { rows: rows.filter((r) => r.tenant_id === params[0] && r.document_id === params[1]) };
      if (sql.startsWith("DELETE")) return { rows: [], rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    } };
    const repo = new PostgresKnowledgeVectorIndexRepository(executor);
    const record = await repo.upsert({ tenant_id: "t1", collection: "docs", document_id: "d1", model_id: 1, chunk_count: 2, status: "indexed", embedding_dimension: 3 });
    expect(record).toMatchObject({ tenant_id: "t1", document_id: "d1", status: "indexed", chunk_count: 2 });
    expect(await repo.listForDocument("t1", "d1")).toHaveLength(1);
  });
});
