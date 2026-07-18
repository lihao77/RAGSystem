import { Pool } from "pg";

import {
  PgPoolMemoryExecutor,
  PostgresConversationRepository,
  PostgresKnowledgeFileMetadataRepository,
  PostgresOutboxRepository,
  PostgresProviderContinuationRepository,
  PostgresPendingInteractionRepository,
  PostgresRunRepository,
  runPostgresConversationMigrations,
  runPostgresKnowledgeFileMigrations,
  runPostgresOutboxMigrations,
  runPostgresPendingInteractionMigrations,
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
  outbox: PostgresOutboxRepository;
  providerContinuations: PostgresProviderContinuationRepository;
  knowledgeFiles: PostgresKnowledgeFileMetadataRepository;
  pendingInteractions: PostgresPendingInteractionRepository;
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
      await runPostgresOutboxMigrations(executor);
      await runPostgresKnowledgeFileMigrations(executor);
      await runPostgresPendingInteractionMigrations(executor);
    }
    const conversation = new PostgresConversationRepository(executor);
    const runs = new PostgresRunRepository(executor);
    const outbox = new PostgresOutboxRepository(executor);
    const providerContinuations = new PostgresProviderContinuationRepository(executor);
    const knowledgeFiles = new PostgresKnowledgeFileMetadataRepository(executor);
    const pendingInteractions = new PostgresPendingInteractionRepository(executor);
    let closePromise: Promise<void> | null = null;
    return {
      conversation,
      runs,
      outbox,
      providerContinuations,
      knowledgeFiles,
      pendingInteractions,
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
