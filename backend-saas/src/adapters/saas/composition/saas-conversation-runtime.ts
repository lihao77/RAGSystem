import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { SecretResolver } from "@ragsystem/backend-core/contracts/integrations/secret-resolver.js";

import {
  PgPoolExecutor,
  type PostgresExecutor,
  PostgresConversationRepository,
  PostgresWorkspaceRepository,
  PostgresOutboxRepository,
  PostgresProviderContinuationRepository,
  PostgresPendingInteractionRepository,
  PostgresProviderRepository,
  PostgresRunRepository,
  TenantBoundPostgresAgentDelegationStore,
  runPostgresConversationMigrations,
  runPostgresChildAgentMigrations,
  runPostgresWsTicketMigrations,
  PostgresWsTicketService,
  PostgresRealtimeEventRelay,
  PostgresRealtimeEventBus,
  runPostgresOutboxMigrations,
  runPostgresPendingInteractionMigrations,
  runPostgresProviderMigrations,
  runPostgresRunMigrations,
  runPostgresBackgroundTaskMigrations,
  PostgresBackgroundTaskRepository,
  runPostgresWorkflowTaskMigrations,
  PostgresWorkflowTaskRepository,
  runPostgresGoalMigrations,
  PostgresGoalRepository,
  runPostgresAnalyticsMigrations,
  PostgresAnalyticsRepository,
  runPostgresFileHistoryMigrations,
  PostgresFileHistoryMetadataRepository,
  PostgresSessionFileMetadataRepository,
  PostgresRuntimeStorage,
  runPostgresSessionFileMigrations,
  runPostgresAgentTeamMigrations,
  PostgresAgentConfigTeamStore,
  runPostgresSystemConfigMigrations,
  PostgresSystemConfigStore,
} from "../../../adapters/saas/postgres/index.js";
import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";
import { OutboxDispatcher } from "@ragsystem/backend-core/services/runtime/event-outbox/dispatcher.js";
import { SaaSFileHistoryStorage } from "../../../adapters/saas/object-storage/file-history-storage.js";
import type { AsyncFileHistoryStore } from "@ragsystem/backend-core/contracts/file-history-store/index.js";
import { SaaSSessionFileStorage } from "../../../adapters/saas/object-storage/session-file-storage.js";
import type { AsyncSessionFileStorage } from "@ragsystem/backend-core/contracts/session/session-file-storage.js";
import { SaaSWorkspaceBlobStorage } from "../../../adapters/saas/object-storage/workspace-blob-storage.js";
import type { WorkspaceBlobStorage } from "@ragsystem/backend-core/contracts/storage/workspace-blob-storage.js";
import type { RuntimeStorage } from "@ragsystem/backend-core/contracts/storage/runtime-storage.js";
import { createTenantId, type TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { WorkflowTaskStore } from "@ragsystem/backend-core/contracts/runtime/workflow-tasks.js";
import type { GoalStore } from "@ragsystem/backend-core/contracts/runtime/goals.js";
import { buildExpiredRunLeaseRecord } from "@ragsystem/backend-core/services/runtime/event-outbox/execution-envelope-archive.js";

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
  /** Shared infrastructure exposed to product plugins that own their schemas and blobs. */
  pluginResources: {
    database: PostgresExecutor;
    objects?: ObjectStorage;
    secrets?: SecretResolver;
  };
  conversation: PostgresConversationRepository;
  workspaces: PostgresWorkspaceRepository;
  wsTickets: PostgresWsTicketService;
  createRealtimeEventBus(tenantId: string): PostgresRealtimeEventBus;
  /** Tenant-bound async child-agent/delegation persistence. */
  createDelegationStore(tenantId: TenantId): TenantBoundPostgresAgentDelegationStore;
  runs: PostgresRunRepository;
  outbox: PostgresOutboxRepository;
  /** Process-level outbox recovery poller shared across all tenant runtimes. */
  sharedOutboxDispatcher: OutboxDispatcher;
  providerContinuations: PostgresProviderContinuationRepository;
  pendingInteractions: PostgresPendingInteractionRepository;
  providers: PostgresProviderRepository;
  backgroundTasks: PostgresBackgroundTaskRepository;
  createWorkflowTaskStore(tenantId: TenantId): WorkflowTaskStore;
  createGoalStore(tenantId: TenantId): GoalStore;
  analytics: PostgresAnalyticsRepository;
  fileHistory: PostgresFileHistoryMetadataRepository;
  createRuntimeStorage(tenantId: TenantId): RuntimeStorage;
  createFileHistoryStorage(tenantId: string): AsyncFileHistoryStore;
  createSessionFileStorage(tenantId: string): AsyncSessionFileStorage;
  createWorkspaceBlobStorage(tenantId: string): WorkspaceBlobStorage;
  /** Tenant-bound agent team configuration store (Postgres source of truth). */
  createAgentConfigTeamStore(tenantId: TenantId): PostgresAgentConfigTeamStore;
  /** Tenant-bound system configuration store (Postgres source of truth). */
  createSystemConfigStore(tenantId: TenantId): PostgresSystemConfigStore;
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
  const executor = new PgPoolExecutor(pool);
  const runtimeOwnerInstanceId = `saas-${process.pid}-${randomUUID()}`;
  try {
    if (options.runMigrations !== false) {
      await runPostgresConversationMigrations(executor);
      await runPostgresRunMigrations(executor);
      await runPostgresChildAgentMigrations(executor);
      await runPostgresWsTicketMigrations(executor);
      await runPostgresOutboxMigrations(executor);
      await runPostgresPendingInteractionMigrations(executor);
      await runPostgresProviderMigrations(executor);
      await runPostgresBackgroundTaskMigrations(executor);
      await runPostgresWorkflowTaskMigrations(executor);
      await runPostgresGoalMigrations(executor);
      await runPostgresAnalyticsMigrations(executor);
      await runPostgresFileHistoryMigrations(executor);
      await runPostgresSessionFileMigrations(executor);
      await runPostgresAgentTeamMigrations(executor);
      await runPostgresSystemConfigMigrations(executor);
    }
    const conversation = new PostgresConversationRepository(executor);
    const workspaces = new PostgresWorkspaceRepository(executor);
    const wsTickets = new PostgresWsTicketService(executor);
    const runs = new PostgresRunRepository(executor);
    const outbox = new PostgresOutboxRepository(executor);
    const realtimeRelay = new PostgresRealtimeEventRelay(realtimeListenerPool, executor, outbox);
    await realtimeRelay.start();
    // One recovery poller for the process — not per tenant runtime.
    const sharedOutboxDispatcher = new OutboxDispatcher(
      outbox,
      null,
      undefined,
      {
        publishFromOutbox: (row, event) => realtimeRelay.publishOutbox(row, event),
      },
    );
    sharedOutboxDispatcher.start();
    let runLeaseRecoveryRunning = false;
    const recoverExpiredRunLeases = async (): Promise<void> => {
      if (runLeaseRecoveryRunning) return;
      runLeaseRecoveryRunning = true;
      try {
        const tenants = await executor.query<{ tenant_id: string }>(
          `SELECT DISTINCT tenant_id FROM saas_runs
           WHERE status='running'
             AND (parent_run_id IS NULL OR owner_instance_id IS NOT NULL)
             AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
           ORDER BY tenant_id`,
        );
        for (const row of tenants.rows) {
          try {
            const storage = new PostgresRuntimeStorage(
              createTenantId(row.tenant_id),
              executor,
              runtimeOwnerInstanceId,
            );
            const recovered = await storage.operations.recoverExpiredRunLeases!({
              buildRunEndedRecord: (run) => buildExpiredRunLeaseRecord(
                run.sessionId,
                run.runId,
                run.status,
                run.reason,
              ),
            });
            if (recovered.records.length > 0) {
              await sharedOutboxDispatcher.dispatchPendingRows(recovered.records.map((record) => record.outbox));
            }
          } catch (error) {
            console.error("[saas-runtime] expired run lease recovery failed", {
              tenant_id: row.tenant_id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        runLeaseRecoveryRunning = false;
      }
    };
    await recoverExpiredRunLeases();
    const runLeaseRecoveryTimer = setInterval(() => {
      void recoverExpiredRunLeases().catch(() => undefined);
    }, 20_000);
    runLeaseRecoveryTimer.unref?.();
    const providerContinuations = new PostgresProviderContinuationRepository(executor);
    const pendingInteractions = new PostgresPendingInteractionRepository(executor);
    const providers = new PostgresProviderRepository(executor, options.secretResolver);
    const backgroundTasks = new PostgresBackgroundTaskRepository(executor);
    const analytics = new PostgresAnalyticsRepository(executor);
    const fileHistory = new PostgresFileHistoryMetadataRepository(executor);
    const sessionFiles = new PostgresSessionFileMetadataRepository(executor);
    let closePromise: Promise<void> | null = null;
    return {
      pluginResources: {
        database: executor,
        ...(options.objectStorage ? { objects: options.objectStorage } : {}),
        ...(options.secretResolver ? { secrets: options.secretResolver } : {}),
      },
      conversation,
      workspaces,
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
      sharedOutboxDispatcher,
      providerContinuations,
      pendingInteractions,
      providers,
      backgroundTasks,
      createWorkflowTaskStore: (tenantId) => new PostgresWorkflowTaskRepository(tenantId, executor),
      createGoalStore: (tenantId) => new PostgresGoalRepository(tenantId, executor),
      analytics,
      fileHistory,
      createRuntimeStorage: (tenantId) => new PostgresRuntimeStorage(tenantId, executor, runtimeOwnerInstanceId),
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
      createAgentConfigTeamStore: (tenantId) => new PostgresAgentConfigTeamStore(tenantId, executor),
      createSystemConfigStore: (tenantId) => new PostgresSystemConfigStore(tenantId, executor),
      close: () => {
        closePromise ??= (async () => {
          clearInterval(runLeaseRecoveryTimer);
          sharedOutboxDispatcher.stop();
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
