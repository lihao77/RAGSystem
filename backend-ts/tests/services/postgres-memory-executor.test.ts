import type { Pool, QueryResult } from "pg";
import { describe, expect, it } from "vitest";

import { PgPoolMemoryExecutor } from "../../src/adapters/saas/postgres/memory-executor.js";

function result(rows: Record<string, unknown>[] = []): QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

describe("PgPoolMemoryExecutor", () => {
  it("delegates non-transactional queries to the pool", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, ...(params == null ? {} : { params }) });
        return result([{ value: 7 }]);
      },
    } as unknown as Pool;

    const executor = new PgPoolMemoryExecutor(pool);
    await expect(executor.query<{ value: number }>("SELECT $1 AS value", [7]))
      .resolves.toEqual({ rows: [{ value: 7 }], rowCount: 1 });
    expect(calls).toEqual([{ sql: "SELECT $1 AS value", params: [7] }]);
  });

  it("commits on success and always releases the client", async () => {
    const sql: string[] = [];
    let releases = 0;
    const client = {
      query: async (text: string) => {
        sql.push(text);
        return result();
      },
      release: () => { releases += 1; },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const executor = new PgPoolMemoryExecutor(pool);

    await expect(executor.transaction(async (tx) => {
      await tx.query("UPDATE memory_entries SET name = name");
      return "done";
    })).resolves.toBe("done");
    expect(sql).toEqual(["BEGIN", "UPDATE memory_entries SET name = name", "COMMIT"]);
    expect(releases).toBe(1);
  });

  it("rolls back on failure and preserves the application error", async () => {
    const sql: string[] = [];
    let releases = 0;
    const client = {
      query: async (text: string) => {
        sql.push(text);
        return result();
      },
      release: () => { releases += 1; },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const executor = new PgPoolMemoryExecutor(pool);
    const failure = new Error("write failed");

    await expect(executor.transaction(async () => { throw failure; })).rejects.toBe(failure);
    expect(sql).toEqual(["BEGIN", "ROLLBACK"]);
    expect(releases).toBe(1);
  });
});
