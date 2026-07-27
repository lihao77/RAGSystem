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

  it("removes real NUL characters from PostgreSQL text parameters", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, ...(params == null ? {} : { params }) });
        return result();
      },
    } as unknown as Pool;

    const executor = new PgPoolMemoryExecutor(pool);
    await executor.query("INSERT INTO messages(content, tags) VALUES($1, $2)", [
      "before\0after",
      ["one\0two", "three"],
    ]);

    expect(calls[0]?.params).toEqual(["beforeafter", ["onetwo", "three"]]);
  });

  it("sanitizes nested JSON NUL values without removing literal \\u0000 text", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, ...(params == null ? {} : { params }) });
        return result();
      },
    } as unknown as Pool;

    const executor = new PgPoolMemoryExecutor(pool);
    await executor.query("INSERT INTO events(payload) VALUES($1::jsonb)", [JSON.stringify({
      content: "before\0after",
      nested: ["keep\\u0000literal", { "key\0part": "value\0part" }],
    })]);

    expect(JSON.parse(String(calls[0]?.params?.[0]))).toEqual({
      content: "beforeafter",
      nested: ["keep\\u0000literal", { keypart: "valuepart" }],
    });
  });

  it("recognizes CAST JSON parameters and leaves JSON-looking text parameters alone", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, ...(params == null ? {} : { params }) });
        return result();
      },
    } as unknown as Pool;

    const executor = new PgPoolMemoryExecutor(pool);
    const jsonText = "{\"content\":\"\\u0000\"}";
    await executor.query("SELECT $1::text, CAST($2 AS JSON)", [jsonText, jsonText]);

    expect(calls[0]?.params).toEqual([jsonText, "{\"content\":\"\"}"]);
  });

  it("commits on success and always releases the client", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    let releases = 0;
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, ...(params == null ? {} : { params }) });
        return result();
      },
      release: () => { releases += 1; },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const executor = new PgPoolMemoryExecutor(pool);

    await expect(executor.transaction(async (tx) => {
      await tx.query("UPDATE conversation_messages SET content=$1", ["tool\0result"]);
      return "done";
    })).resolves.toBe("done");
    expect(calls).toEqual([
      { sql: "BEGIN" },
      { sql: "UPDATE conversation_messages SET content=$1", params: ["toolresult"] },
      { sql: "COMMIT" },
    ]);
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
