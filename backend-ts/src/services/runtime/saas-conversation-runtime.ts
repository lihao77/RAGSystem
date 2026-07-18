import { Pool } from "pg";
import type { SecretResolver } from "../../contracts/secret-resolver.js";

import {
  PgPoolMemoryExecutor,
  PostgresConversationRepository,
  PostgresKnowledgeFileMetadataRepository,
  PostgresArtifactMetadataRepository,
  PostgresOutboxRepository,
  PostgresProviderContinuationRepository,
  PostgresPendingInteractionRepository,
  PostgresProviderMcpRepository,
  PostgresRunRepository,
  runPostgresConversationMigrations,
  runPostgresKnowledgeFileMigrations,
  runPostgresOutboxMigrations,
  runPostgresPendingInteractionMigrations,
  runPostgresArtifactMigrations,
  runPostgresProviderMcpMigrations,
  runPostgresRunMigrations,
} from "../../adapters/saas/postgres/index.js";
import type { ObjectStorage } from "../../contracts/object-storage.js";
import { SaaSArtifactService } from "../artifacts/saas-artifact-service.js";

export interface SaaSConversationRuntimeOptions {
  connectionString: string;
  poolMax?: number;
  pool?: Pool;
  runMigrations?: boolean;
  secretResolver?: SecretResolver;
  objectStorage?: ObjectStorage;
}

/** Shared PostgreSQL lifecycle for the async SaaS conversation/run repositories. */
export interface SaaSConversationRuntimeHandle {
  conversation: PostgresConversationRepository;
  runs: PostgresRunRepository;
  outbox: PostgresOutboxRepository;
  providerContinuations: PostgresProviderContinuationRepository;
  knowledgeFiles: PostgresKnowledgeFileMetadataRepository;
  pendingInteractions: PostgresPendingInteractionRepository;
  artifacts: PostgresArtifactMetadataRepository;
  /** Tenant-bound blob facade; requires objectStorage in the composition root. */
  createArtifactService(tenantId: string): SaaSArtifactService;
  providerMcp: PostgresProviderMcpRepository;
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
      await runPostgresArtifactMigrations(executor);
      await runPostgresProviderMcpMigrations(executor);
    }
    const conversation = new PostgresConversationRepository(executor);
    const runs = new PostgresRunRepository(executor);
    const outbox = new PostgresOutboxRepository(executor);
    const providerContinuations = new PostgresProviderContinuationRepository(executor);
    const knowledgeFiles = new PostgresKnowledgeFileMetadataRepository(executor);
    const pendingInteractions = new PostgresPendingInteractionRepository(executor);
    const artifacts = new PostgresArtifactMetadataRepository(executor);
    const providerMcp = new PostgresProviderMcpRepository(executor, options.secretResolver);
    let closePromise: Promise<void> | null = null;
    return {
      conversation,
      runs,
      outbox,
      providerContinuations,
      knowledgeFiles,
      pendingInteractions,
      artifacts,
      createArtifactService: (tenantId) => {
        if (!options.objectStorage) throw new Error("SaaS artifact service requires ObjectStorage");
        return new SaaSArtifactService(tenantId, artifacts, options.objectStorage);
      },
      providerMcp,
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
