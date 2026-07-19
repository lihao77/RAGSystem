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
  runPostgresVectorIndexMigrations,
  PostgresKnowledgeVectorIndexRepository,
  runPostgresPgVectorMigrations,
  PostgresPgVectorRepository,
  runPostgresRunMigrations,
  runPostgresBackgroundTaskMigrations,
  PostgresBackgroundTaskRepository,
  runPostgresAnalyticsMigrations,
  PostgresAnalyticsRepository,
  runPostgresFileHistoryMigrations,
  PostgresFileHistoryMetadataRepository,
  PostgresSessionFileMetadataRepository,
  runPostgresSessionFileMigrations,
} from "../../adapters/saas/postgres/index.js";
import type { ObjectStorage } from "../../contracts/object-storage.js";
import { SaaSArtifactService } from "../artifacts/saas-artifact-service.js";
import { SaaSKnowledgeFileStorage } from "../../adapters/saas/object-storage/knowledge-file-storage.js";
import type { AsyncKnowledgeFileStore } from "../../contracts/knowledge/async-knowledge-file-store.js";
import { SaaSProviderMcpApplication } from "./saas-provider-mcp-application.js";
import { SaaSFileHistoryStorage } from "../../adapters/saas/object-storage/file-history-storage.js";
import type { AsyncFileHistoryStore } from "../../contracts/file-history-store/index.js";
import { SaaSSessionFileStorage } from "../../adapters/saas/object-storage/session-file-storage.js";
import type { AsyncSessionFileStorage } from "../../contracts/session-file-storage.js";
import { SaaSWorkspaceBlobStorage } from "../../adapters/saas/object-storage/workspace-blob-storage.js";
import type { WorkspaceBlobStorage } from "../../contracts/workspace-blob-storage.js";
import type { KnowledgeQueryPort } from "../../contracts/knowledge/query-port.js";
import type { KnowledgeBaseService } from "../knowledge/knowledge-base-service.js";
import { PostgresKnowledgeQueryAdapter } from "../../adapters/saas/postgres/knowledge-query-adapter.js";

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
  /** Tenant-bound asynchronous knowledge metadata/blob facade. */
  createKnowledgeFileStorage(tenantId: string): AsyncKnowledgeFileStore;
  vectorIndex: PostgresKnowledgeVectorIndexRepository;
  /** Tenant-scoped vector data-plane backed by PostgreSQL pgvector. */
  vectorStore: PostgresPgVectorRepository;
  /** Tenant-bound Agent knowledge query port backed by PostgreSQL pgvector. */
  createKnowledgeQuery(tenantId: string, baseKnowledge: KnowledgeBaseService): KnowledgeQueryPort;
  providerMcp: PostgresProviderMcpRepository;
  providerMcpApplication: SaaSProviderMcpApplication;
  backgroundTasks: PostgresBackgroundTaskRepository;
  analytics: PostgresAnalyticsRepository;
  fileHistory: PostgresFileHistoryMetadataRepository;
  createFileHistoryStorage(tenantId: string): AsyncFileHistoryStore;
  createSessionFileStorage(tenantId: string): AsyncSessionFileStorage;
  createWorkspaceBlobStorage(tenantId: string): WorkspaceBlobStorage;
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
      await runPostgresVectorIndexMigrations(executor);
      await runPostgresPgVectorMigrations(executor);
      await runPostgresBackgroundTaskMigrations(executor);
      await runPostgresAnalyticsMigrations(executor);
      await runPostgresFileHistoryMigrations(executor);
      await runPostgresSessionFileMigrations(executor);
    }
    const conversation = new PostgresConversationRepository(executor);
    const runs = new PostgresRunRepository(executor);
    const outbox = new PostgresOutboxRepository(executor);
    const providerContinuations = new PostgresProviderContinuationRepository(executor);
    const knowledgeFiles = new PostgresKnowledgeFileMetadataRepository(executor);
    const pendingInteractions = new PostgresPendingInteractionRepository(executor);
    const artifacts = new PostgresArtifactMetadataRepository(executor);
    const providerMcp = new PostgresProviderMcpRepository(executor, options.secretResolver);
    const vectorIndex = new PostgresKnowledgeVectorIndexRepository(executor);
    const vectorStore = new PostgresPgVectorRepository(executor);
    const backgroundTasks = new PostgresBackgroundTaskRepository(executor);
    const analytics = new PostgresAnalyticsRepository(executor);
    const fileHistory = new PostgresFileHistoryMetadataRepository(executor);
    const sessionFiles = new PostgresSessionFileMetadataRepository(executor);
    let closePromise: Promise<void> | null = null;
    const providerMcpApplication = new SaaSProviderMcpApplication(providerMcp);
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
      createKnowledgeFileStorage: (tenantId) => {
        if (!options.objectStorage) throw new Error("SaaS knowledge file storage requires ObjectStorage");
        return new SaaSKnowledgeFileStorage(tenantId, knowledgeFiles, options.objectStorage);
      },
      providerMcp,
      providerMcpApplication,
      vectorIndex,
      vectorStore,
      createKnowledgeQuery: (tenantId, baseKnowledge) => new PostgresKnowledgeQueryAdapter(
        tenantId,
        baseKnowledge,
        vectorStore,
      ),
      backgroundTasks,
      analytics,
      fileHistory,
      createFileHistoryStorage: (tenantId) => {
        if (!options.objectStorage) throw new Error("SaaS file history requires ObjectStorage");
        return new SaaSFileHistoryStorage(tenantId, fileHistory, options.objectStorage);
      },
      createSessionFileStorage: (tenantId) => {
        if (!options.objectStorage) throw new Error("SaaS session file storage requires ObjectStorage");
        return new SaaSSessionFileStorage(tenantId, sessionFiles, options.objectStorage);
      },
      createWorkspaceBlobStorage: (tenantId) => {
        if (!options.objectStorage) throw new Error("SaaS workspace blob storage requires ObjectStorage");
        return new SaaSWorkspaceBlobStorage(
          tenantId,
          options.objectStorage,
          new SaaSFileHistoryStorage(tenantId, fileHistory, options.objectStorage),
        );
      },
      close: () => {
        providerMcpApplication.close();
        closePromise ??= ownsPool ? pool.end() : Promise.resolve();
        return closePromise;
      },
    };
  } catch (error) {
    if (ownsPool) await pool.end().catch(() => undefined);
    throw error;
  }
}
