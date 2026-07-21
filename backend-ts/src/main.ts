import { buildApp } from "./app.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { loadEnv } from "./config/env.js";
import { createSaaSMemoryRuntime, type SaaSMemoryRuntimeHandle } from "./adapters/saas/composition/saas-memory-runtime.js";
import { createSaaSControlRuntime, type SaaSControlRuntimeHandle } from "./adapters/saas/composition/saas-control-runtime.js";
import { createSaaSConversationRuntime, type SaaSConversationRuntimeHandle } from "./adapters/saas/composition/saas-conversation-runtime.js";
import { createSaaSObjectStorage } from "./adapters/saas/composition/saas-object-storage.js";
import type { ObjectStorage } from "./contracts/storage/object-storage.js";
import { TenantKnowledgeMarkdownPipeline } from "./contracts/knowledge/async-knowledge-markdown-pipeline.js";
import { KnowledgeHttpApplication } from "./services/knowledge/knowledge-http-application.js";
import { DocumentExtractDispatcher } from "./services/knowledge/document-extract/dispatcher.js";
import type { AsyncKnowledgeFileStore } from "./contracts/knowledge/async-knowledge-file-store.js";
import { SaaSSessionApplication } from "./adapters/saas/application/session/saas-session-application.js";
import { SaaSAgentReadApplication } from "./adapters/saas/application/execution/saas-agent-read-application.js";
import { SaaSAnalyticsApplication } from "./adapters/saas/application/analytics/saas-analytics-application.js";
import { SaaSMonitoringApplication } from "./adapters/saas/application/monitoring/saas-monitoring-application.js";
import type { FastifyRequest } from "fastify";
import { SaaSExecutionMemoryCandidates } from "./adapters/saas/application/memory/saas-execution-memory-candidates.js";
import { SaaSSessionFileApplication } from "./adapters/saas/application/session-file/saas-session-file-application.js";
import { SaaSFileChangeApplication } from "./adapters/saas/application/file-change/saas-file-change-application.js";
import { RuntimeExecutionApplication } from "./services/agent/execution/runtime-execution-application.js";
import { SaaSProviderApplication } from "./adapters/saas/application/provider-mcp/saas-provider-application.js";
import { SaaSMcpApplication } from "./adapters/saas/application/provider-mcp/saas-mcp-application.js";

const env = loadEnv(process.env);
let saasMemoryRuntime: SaaSMemoryRuntimeHandle | undefined;
let saasControlRuntime: SaaSControlRuntimeHandle | undefined;
let saasConversationRuntime: SaaSConversationRuntimeHandle | undefined;
let saasObjectStorage: ObjectStorage | undefined;
/** Shared data-plane pool for memory + conversation (same DATABASE_URL). */
let saasDataPool: Pool | undefined;
let app;
try {
  if (env.storageMode === "postgres") {
    if (!env.databaseUrl) throw new Error("STORAGE_MODE=postgres requires DATABASE_URL");
    saasDataPool = new Pool({
      connectionString: env.databaseUrl,
      max: Math.max(1, env.postgresPoolMax ?? 10),
    });
    saasMemoryRuntime = await createSaaSMemoryRuntime({
      connectionString: env.databaseUrl,
      pool: saasDataPool,
    });
    saasObjectStorage = createSaaSObjectStorage({ mode: "s3", bucket: env.objectStorageBucket!, endpoint: env.objectStorageEndpoint!, accessKeyId: env.objectStorageAccessKeyId!, secretAccessKey: env.objectStorageSecretAccessKey!, region: env.objectStorageRegion, forcePathStyle: env.objectStorageForcePathStyle });
  }
  if (env.controlStorageMode === "postgres") {
    if (!env.controlDatabaseUrl || !env.controlSecretMasterKey) {
      throw new Error("CONTROL_STORAGE_MODE=postgres requires CONTROL_DATABASE_URL and CONTROL_SECRET_MASTER_KEY");
    }
    saasControlRuntime = await createSaaSControlRuntime({
      connectionString: env.controlDatabaseUrl,
      masterKey: env.controlSecretMasterKey,
      poolMax: env.postgresPoolMax,
    });
  }
  if (env.storageMode === "postgres") {
    if (!env.databaseUrl || !saasDataPool) throw new Error("STORAGE_MODE=postgres requires DATABASE_URL");
    saasConversationRuntime = await createSaaSConversationRuntime({
      connectionString: env.databaseUrl,
      pool: saasDataPool,
      ...(saasControlRuntime ? { secretResolver: saasControlRuntime.secretResolver } : {}),
      ...(saasObjectStorage ? { objectStorage: saasObjectStorage } : {}),
    });
  }
  app = await buildApp({
    env,
    ...(saasMemoryRuntime ? { saasMemoryRuntime } : {}),
    ...(saasConversationRuntime ? { saasConversationRuntime } : {}),
    ...(saasConversationRuntime && saasObjectStorage ? {
      resolveKnowledgeFileStore: (request) => saasConversationRuntime!.createKnowledgeFileStorage(request.identity.tenantId),
      resolveSessionFileStorage: (request) => saasConversationRuntime!.createSessionFileStorage(request.identity.tenantId),
      resolveKnowledgeMarkdownPipeline: (request) => createSaaSKnowledgeMarkdownPipeline(
        request,
        saasConversationRuntime!.createKnowledgeFileStorage(request.identity.tenantId),
      ),
      resolveKnowledgeApplication: (request) => {
        const files = saasConversationRuntime!.createKnowledgeFileStorage(request.identity.tenantId);
        const markdown = createSaaSKnowledgeMarkdownPipeline(request, files);
        const knowledge = request.container.knowledge as import("./services/knowledge/knowledge-application-service.js").KnowledgeApplicationService;
        return new KnowledgeHttpApplication(
          knowledge,
          files,
          markdown,
        );
      },
    } : {}),
    ...(saasConversationRuntime ? {
      resolveArtifactApplication: (request: FastifyRequest) => saasConversationRuntime!.createArtifactService(request.identity.tenantId),
      resolveFileHistoryStorage: (request: FastifyRequest) => saasConversationRuntime!.createFileHistoryStorage(request.identity.tenantId),
      resolveSessionFileApplication: (request: FastifyRequest) => new SaaSSessionFileApplication(
        saasConversationRuntime!.createSessionFileStorage(request.identity.tenantId),
      ),
      resolveFileChangeApplication: (request: FastifyRequest) => new SaaSFileChangeApplication(
        saasConversationRuntime!.createFileHistoryStorage(request.identity.tenantId),
      ),
      resolveProviderApplication: (request) => new SaaSProviderApplication(
        request.identity.tenantId,
        request.container.modelAdapter,
        saasConversationRuntime!.providerMcp,
      ),
      resolveMcpApplication: (request) => new SaaSMcpApplication(
        request.identity.tenantId,
        saasConversationRuntime!.providerMcpApplication,
        saasConversationRuntime!.providerMcp,
      ),
      resolveSessionApplication: (request: FastifyRequest) => new SaaSSessionApplication(
        request.identity.tenantId,
        saasConversationRuntime!.conversation,
        saasConversationRuntime!.createFileHistoryStorage(request.identity.tenantId),
        saasConversationRuntime!.runs,
        saasConversationRuntime!.outbox,
        new SaaSExecutionMemoryCandidates(request.identity.tenantId, saasMemoryRuntime!.repository),
      ),
      resolveExecutionRead: (request: FastifyRequest) => new SaaSAgentReadApplication(
        request.identity.tenantId,
        saasConversationRuntime!.conversation,
        saasConversationRuntime!.runs,
        saasConversationRuntime!.outbox,
        request.container.agentExecution,
      ),
      resolveExecutionApplication: (request: FastifyRequest) => new RuntimeExecutionApplication(
        request.container.agentExecution,
      ),
      resolveAnalytics: (request: FastifyRequest) => new SaaSAnalyticsApplication(
        request.identity.tenantId,
        saasConversationRuntime!.analytics,
      ),
      resolveMonitoringApplication: (request: FastifyRequest) => new SaaSMonitoringApplication(
        request.identity.tenantId,
        saasConversationRuntime!.outbox,
      ),
    } : {}),
    ...(saasControlRuntime ? { controlRuntime: saasControlRuntime } : {}),
  });
} catch (error) {
  await saasMemoryRuntime?.close().catch(() => undefined);
  await saasConversationRuntime?.close().catch(() => undefined);
  await saasControlRuntime?.close().catch(() => undefined);
  await saasDataPool?.end().catch(() => undefined);
  throw error;
}

let address: string;
try {
  address = await app.listen({ host: env.host, port: env.port });
} catch (error) {
  await app.close().catch(() => undefined);
  await saasDataPool?.end().catch(() => undefined);
  saasDataPool = undefined;
  throw error;
}
app.log.info({
  address,
  storageMode: env.storageMode ?? "sqlite",
  controlStorageMode: env.controlStorageMode ?? "sqlite",
  memoryStorage: saasMemoryRuntime ? "postgres" : "local",
  runtimeProfile: saasMemoryRuntime ? "hybrid" : "local",
}, "backend-ts listening");

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "backend-ts shutting down");
  try {
    // app.onClose 先关 memory/conversation runtime（它们不 end 共享 pool），再 end 共享 data pool。
    await app.close();
    await saasDataPool?.end().catch((error) => {
      app.log.error({ error }, "backend-ts shared data pool end failed");
    });
    saasDataPool = undefined;
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, "backend-ts shutdown failed");
    await saasDataPool?.end().catch(() => undefined);
    saasDataPool = undefined;
    process.exit(1);
  }
};

function createSaaSKnowledgeMarkdownPipeline(request: FastifyRequest, files: AsyncKnowledgeFileStore) {
  const dispatcher = new DocumentExtractDispatcher(request.container.systemConfig.getDocumentExtractionConfig());
  return new TenantKnowledgeMarkdownPipeline(files, async ({ body, fileName, mime }) => {
    const temporaryPath = path.join(os.tmpdir(), `ragsystem-knowledge-${randomUUID()}-${path.basename(fileName)}`);
    await fs.writeFile(temporaryPath, body);
    try {
      return (await dispatcher.extract({ file_path: temporaryPath, file_name: fileName, mime })).markdown;
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
