import { Pool } from "pg";
import type { SecretResolver } from "../../../contracts/integrations/secret-resolver.js";

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
  TenantBoundPostgresAgentDelegationStore,
  runPostgresConversationMigrations,
  runPostgresChildAgentMigrations,
  runPostgresWsTicketMigrations,
  PostgresWsTicketService,
  PostgresRealtimeEventRelay,
  PostgresRealtimeEventBus,
  runPostgresKnowledgeFileMigrations,
  runPostgresKnowledgeConfigMigrations,
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
  PostgresRuntimeStorage,
  runPostgresSessionFileMigrations,
} from "../../../adapters/saas/postgres/index.js";
import type { ObjectStorage } from "../../../contracts/storage/object-storage.js";
import { SaaSArtifactService } from "../../../adapters/saas/application/artifacts/saas-artifact-application.js";
import { SaaSKnowledgeFileStorage } from "../../../adapters/saas/object-storage/knowledge-file-storage.js";
import type { AsyncKnowledgeFileStore } from "../../../contracts/knowledge/async-knowledge-file-store.js";
import { SaaSProviderMcpApplication } from "../../../adapters/saas/application/provider-mcp/saas-provider-mcp-application.js";
import { SaaSFileHistoryStorage } from "../../../adapters/saas/object-storage/file-history-storage.js";
import type { AsyncFileHistoryStore } from "../../../contracts/file-history-store/index.js";
import { SaaSSessionFileStorage } from "../../../adapters/saas/object-storage/session-file-storage.js";
import type { AsyncSessionFileStorage } from "../../../contracts/session/session-file-storage.js";
import { SaaSWorkspaceBlobStorage } from "../../../adapters/saas/object-storage/workspace-blob-storage.js";
import type { WorkspaceBlobStorage } from "../../../contracts/storage/workspace-blob-storage.js";
import type { KnowledgeQueryPort } from "../../../contracts/knowledge/query-port.js";
import { PostgresKnowledgeQueryAdapter } from "../../../adapters/saas/postgres/knowledge-query-adapter.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { TenantId } from "../../../identity/types.js";
import { PostgresKnowledgeConfigRepository } from "../../../adapters/saas/postgres/knowledge-config-repository.js";
import { KnowledgeApplicationService } from "../../../services/knowledge/knowledge-application-service.js";
import type { ModelAdapterService } from "../../../services/integrations/model-adapter-service.js";

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
  wsTickets: PostgresWsTicketService;
  createRealtimeEventBus(tenantId: string): PostgresRealtimeEventBus;
  /** Tenant-bound async child-agent/delegation persistence. */
  createDelegationStore(tenantId: TenantId): TenantBoundPostgresAgentDelegationStore;
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
  knowledgeConfig: PostgresKnowledgeConfigRepository;
  createKnowledgeService(tenantId: string, modelAdapter: ModelAdapterService): KnowledgeApplicationService;
  createKnowledgeQuery(tenantId: string, modelAdapter: ModelAdapterService): KnowledgeQueryPort;
  providerMcp: PostgresProviderMcpRepository;
  providerMcpApplication: SaaSProviderMcpApplication;
  backgroundTasks: PostgresBackgroundTaskRepository;
  analytics: PostgresAnalyticsRepository;
  fileHistory: PostgresFileHistoryMetadataRepository;
  createRuntimeStorage(tenantId: TenantId): RuntimeStorage;
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
  const realtimeListenerPool = connectionString ? new Pool({ connectionString, max: 1 }) : pool;
  const ownsRealtimeListenerPool = realtimeListenerPool !== pool;
  const executor = new PgPoolMemoryExecutor(pool);
  try {
    if (options.runMigrations !== false) {
      await runPostgresConversationMigrations(executor);
      await runPostgresRunMigrations(executor);
      await runPostgresChildAgentMigrations(executor);
      await runPostgresWsTicketMigrations(executor);
      await runPostgresOutboxMigrations(executor);
      await runPostgresKnowledgeFileMigrations(executor);
      await runPostgresKnowledgeConfigMigrations(executor);
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
    const wsTickets = new PostgresWsTicketService(executor);
    const runs = new PostgresRunRepository(executor);
    const outbox = new PostgresOutboxRepository(executor);
    const realtimeRelay = new PostgresRealtimeEventRelay(realtimeListenerPool, executor, outbox);
    await realtimeRelay.start();
    const providerContinuations = new PostgresProviderContinuationRepository(executor);
    const knowledgeFiles = new PostgresKnowledgeFileMetadataRepository(executor);
    const pendingInteractions = new PostgresPendingInteractionRepository(executor);
    const artifacts = new PostgresArtifactMetadataRepository(executor);
    const providerMcp = new PostgresProviderMcpRepository(executor, options.secretResolver);
    const vectorIndex = new PostgresKnowledgeVectorIndexRepository(executor);
    const vectorStore = new PostgresPgVectorRepository(executor);
    const knowledgeConfig = new PostgresKnowledgeConfigRepository(executor);
    const backgroundTasks = new PostgresBackgroundTaskRepository(executor);
    const analytics = new PostgresAnalyticsRepository(executor);
    const fileHistory = new PostgresFileHistoryMetadataRepository(executor);
    const sessionFiles = new PostgresSessionFileMetadataRepository(executor);
    let closePromise: Promise<void> | null = null;
    const providerMcpApplication = new SaaSProviderMcpApplication(providerMcp);
    return {
      conversation,
      wsTickets,
      createRealtimeEventBus: (tenantId) => realtimeRelay.createBus(tenantId),
      createDelegationStore: (tenantId) => new TenantBoundPostgresAgentDelegationStore(
        tenantId,
        executor,
        conversation,
        runs,
      ),
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
      knowledgeConfig,
      createKnowledgeService: (tenantId, modelAdapter) => new KnowledgeApplicationService(tenantId, modelAdapter, knowledgeConfig, vectorStore),
      createKnowledgeQuery: (tenantId, modelAdapter) => new PostgresKnowledgeQueryAdapter(new KnowledgeApplicationService(tenantId, modelAdapter, knowledgeConfig, vectorStore)),
      backgroundTasks,
      analytics,
      fileHistory,
      createRuntimeStorage: (tenantId) => new PostgresRuntimeStorage(tenantId, executor),
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
        closePromise ??= (async () => {
          providerMcpApplication.close();
          await realtimeRelay.close();
          if (ownsRealtimeListenerPool) await realtimeListenerPool.end();
          if (ownsPool) await pool.end();
        })();
        return closePromise;
      },
    };
  } catch (error) {
    if (ownsRealtimeListenerPool) await realtimeListenerPool.end().catch(() => undefined);
    if (ownsPool) await pool.end().catch(() => undefined);
    throw error;
  }
}
