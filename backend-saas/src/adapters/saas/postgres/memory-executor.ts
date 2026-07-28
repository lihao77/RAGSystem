import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import type {
  PostgresMemoryExecutor,
  PostgresQueryResult,
} from "./memory-repository.js";
import { sanitizePostgresParams } from "./parameter-sanitizer.js";

function memoryQueryResult<Row extends Record<string, unknown>>(
  result: QueryResult<QueryResultRow>,
): PostgresQueryResult<Row> {
  return {
    rows: result.rows as Row[],
    ...(result.rowCount == null ? {} : { rowCount: result.rowCount }),
  };
}

class PgClientMemoryExecutor implements PostgresMemoryExecutor {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    const result = await this.client.query(
      sql,
      params == null ? undefined : sanitizePostgresParams(sql, params),
    );
    return memoryQueryResult<Row>(result);
  }

  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/** PostgreSQL executor backed by a shared pg Pool. */
export class PgPoolMemoryExecutor implements PostgresMemoryExecutor {
  constructor(private readonly pool: Pool) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    const result = await this.pool.query(
      sql,
      params == null ? undefined : sanitizePostgresParams(sql, params),
    );
    return memoryQueryResult<Row>(result);
  }

  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgClientMemoryExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        if (error instanceof Error) {
          error.cause ??= rollbackError;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
