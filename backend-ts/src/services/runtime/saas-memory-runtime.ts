import { Pool } from "pg";

import {
  PgPoolMemoryExecutor,
  PostgresMemoryRepository,
  runPostgresMemoryMigrations,
} from "../../adapters/saas/postgres/index.js";
import { SaaSRuntimeProvider } from "./saas-runtime-provider.js";

export interface SaaSMemoryRuntimeOptions {
  connectionString: string;
  poolMax?: number;
  pool?: Pool;
  runMigrations?: boolean;
}

export interface SaaSMemoryRuntimeHandle {
  provider: SaaSRuntimeProvider;
  repository: PostgresMemoryRepository;
  close(): Promise<void>;
}

/** Creates the shared PostgreSQL resources used by the memory-only SaaS runtime. */
export async function createSaaSMemoryRuntime(options: SaaSMemoryRuntimeOptions): Promise<SaaSMemoryRuntimeHandle> {
  const connectionString = options.connectionString.trim();
  if (!connectionString) throw new Error("SaaS memory runtime requires a PostgreSQL connection string");
  const ownsPool = !options.pool;
  const pool = options.pool ?? new Pool({
    connectionString,
    max: Math.max(1, options.poolMax ?? 10),
  });
  const executor = new PgPoolMemoryExecutor(pool);
  try {
    if (options.runMigrations !== false) await runPostgresMemoryMigrations(executor);
    const repository = new PostgresMemoryRepository(executor);
    const provider = new SaaSRuntimeProvider(repository);
    let closePromise: Promise<void> | null = null;
    const closeResources = async (): Promise<void> => {
      if (ownsPool) await pool.end();
    };
    return {
      provider,
      repository,
      close: () => {
        closePromise ??= closeResources();
        return closePromise;
      },
    };
  } catch (error) {
    if (ownsPool) await pool.end().catch(() => undefined);
    throw error;
  }
}
