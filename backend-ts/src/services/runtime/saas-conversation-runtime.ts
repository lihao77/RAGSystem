import { Pool } from "pg";

import {
  PgPoolMemoryExecutor,
  PostgresConversationRepository,
  PostgresRunRepository,
  runPostgresConversationMigrations,
  runPostgresRunMigrations,
} from "../../adapters/saas/postgres/index.js";

export interface SaaSConversationRuntimeOptions {
  connectionString: string;
  poolMax?: number;
  pool?: Pool;
  runMigrations?: boolean;
}

/** Shared PostgreSQL lifecycle for the async SaaS conversation/run repositories. */
export interface SaaSConversationRuntimeHandle {
  conversation: PostgresConversationRepository;
  runs: PostgresRunRepository;
  close(): Promise<void>;
}

export async function createSaaSConversationRuntime(
  options: SaaSConversationRuntimeOptions,
): Promise<SaaSConversationRuntimeHandle> {
  const connectionString = options.connectionString.trim();
  if (!connectionString && !options.pool) throw new Error("SaaS conversation runtime requires a PostgreSQL connection string");
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? new Pool({ connectionString, max: Math.max(1, options.poolMax ?? 10) });
  const executor = new PgPoolMemoryExecutor(pool);
  try {
    if (options.runMigrations !== false) {
      await runPostgresConversationMigrations(executor);
      await runPostgresRunMigrations(executor);
    }
    const conversation = new PostgresConversationRepository(executor);
    const runs = new PostgresRunRepository(executor);
    let closePromise: Promise<void> | null = null;
    return {
      conversation,
      runs,
      close: () => {
        closePromise ??= ownsPool ? pool.end() : Promise.resolve();
        return closePromise;
      },
    };
  } catch (error) {
    if (ownsPool) await pool.end().catch(() => undefined);
    throw error;
  }
}
