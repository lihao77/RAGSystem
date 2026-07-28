import { Pool } from "pg";

import type { DeploymentRuntime } from "@ragsystem/backend-core/app/deployment-runtime.js";
import type { AppEnv } from "@ragsystem/backend-core/config/env.js";
import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";
import { RuntimeExecutionApplication } from "@ragsystem/backend-core/services/agent/execution/runtime-execution-application.js";
import { PasswordIdentityProvider } from "@ragsystem/backend-core/services/identity/index.js";
import { SaaSAnalyticsApplication } from "../application/analytics/saas-analytics-application.js";
import { SaaSAgentReadApplication } from "../application/execution/saas-agent-read-application.js";
import { SaaSFileChangeApplication } from "../application/file-change/saas-file-change-application.js";
import { SaaSMonitoringApplication } from "../application/monitoring/saas-monitoring-application.js";
import { SaaSMcpApplication } from "../application/provider-mcp/saas-mcp-application.js";
import { SaaSProviderApplication } from "../application/provider-mcp/saas-provider-application.js";
import { SaaSSessionApplication } from "../application/session/saas-session-application.js";
import { SaaSSessionFileApplication } from "../application/session-file/saas-session-file-application.js";
import { createSaaSControlRuntime, type SaaSControlRuntimeHandle } from "./saas-control-runtime.js";
import { createSaaSConversationRuntime, type SaaSConversationRuntimeHandle } from "./saas-conversation-runtime.js";
import { createSaaSObjectStorage } from "./saas-object-storage.js";
import { SaaSTenantRuntimeRegistry } from "./saas-tenant-runtime-registry.js";
import type { PostgresExecutor } from "../postgres/postgres-executor.js";

export interface SaaSDeploymentRuntime extends DeploymentRuntime {
  readonly pluginResources: {
    database: PostgresExecutor;
    objects: ObjectStorage;
  };
}

export async function createSaaSDeploymentRuntime(env: AppEnv): Promise<SaaSDeploymentRuntime> {
  validateSaaSEnv(env);

  let dataPool: Pool | undefined;
  let controlRuntime: SaaSControlRuntimeHandle | undefined;
  let conversationRuntime: SaaSConversationRuntimeHandle | undefined;
  let objectStorage: ObjectStorage | undefined;

  try {
    dataPool = new Pool({
      connectionString: env.databaseUrl!,
      max: Math.max(1, env.postgresPoolMax),
    });
    objectStorage = createSaaSObjectStorage({
      mode: "s3",
      bucket: env.objectStorageBucket!,
      endpoint: env.objectStorageEndpoint!,
      accessKeyId: env.objectStorageAccessKeyId!,
      secretAccessKey: env.objectStorageSecretAccessKey!,
      region: env.objectStorageRegion,
      forcePathStyle: env.objectStorageForcePathStyle,
    });
    controlRuntime = await createSaaSControlRuntime({
      connectionString: env.controlDatabaseUrl!,
      masterKey: env.controlSecretMasterKey!,
      poolMax: env.postgresPoolMax,
    });
    conversationRuntime = await createSaaSConversationRuntime({
      connectionString: env.databaseUrl!,
      pool: dataPool,
      secretResolver: controlRuntime.secretResolver,
      objectStorage,
    });
  } catch (error) {
    await closePartialRuntime(conversationRuntime, controlRuntime, dataPool);
    throw error;
  }

  const control = controlRuntime;
  const conversation = conversationRuntime;
  const pool = dataPool;
  const objects = objectStorage;
  if (!objects) throw new Error("SaaS artifact plugin requires ObjectStorage");
  let closed = false;

  return {
    controlPlane: control.controlPlane,
    botRepository: control.botRepository,
    widgetCredentials: control.widgetCredentials,
    daemonLeaderLease: control.daemonLeaderLease,
    wsTickets: conversation.wsTickets,
    pluginResources: { database: conversation.pluginResources.database, objects },
    applications: {
      resolveSessionFileApplication: (request) => new SaaSSessionFileApplication(
        conversation.createSessionFileStorage(request.identity.tenantId),
      ),
      resolveFileChangeApplication: (request) => new SaaSFileChangeApplication(
        conversation.createFileHistoryStorage(request.identity.tenantId),
      ),
      resolveProviderApplication: (request) => new SaaSProviderApplication(
        request.identity.tenantId,
        request.container.modelAdapter,
        conversation.providerMcp,
      ),
      resolveMcpApplication: (request) => new SaaSMcpApplication(
        request.identity.tenantId,
        conversation.providerMcpApplication,
        conversation.providerMcp,
      ),
      resolveSessionApplication: (request) => new SaaSSessionApplication(
        request.identity.tenantId,
        conversation.conversation,
        conversation.createFileHistoryStorage(request.identity.tenantId),
        conversation.runs,
        conversation.outbox,
        conversation.workspaces,
      ),
      resolveExecutionRead: (request) => new SaaSAgentReadApplication(
        request.identity.tenantId,
        conversation.conversation,
        conversation.runs,
        conversation.outbox,
        request.container.agentExecution,
      ),
      resolveExecutionApplication: (request) => new RuntimeExecutionApplication(request.container.agentExecution),
      resolveAnalytics: (request) => new SaaSAnalyticsApplication(
        request.identity.tenantId,
        conversation.analytics,
      ),
      resolveMonitoringApplication: (request) => new SaaSMonitoringApplication(
        request.identity.tenantId,
        conversation.outbox,
      ),
    },
    createRegistry: (logger, plugins) => new SaaSTenantRuntimeRegistry(
      env,
      control.controlPlane.tenants,
      conversation,
      logger,
      {
        ...(plugins ? { plugins } : {}),
      },
    ),
    createIdentityProvider: (authMode, sessionTokens) => {
      if (authMode === "password" && sessionTokens) {
        return new PasswordIdentityProvider(control.controlPlane, sessionTokens);
      }
      if (authMode === "oidc") throw new Error("SaaS OIDC identity is not implemented");
      throw new Error(`SaaS backend requires password or OIDC identity; received: ${authMode}`);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await closePartialRuntime(conversation, control, pool);
    },
  };
}

function validateSaaSEnv(env: AppEnv): void {
  if (env.deploymentMode !== "saas") throw new Error("SaaS backend requires DEPLOYMENT_MODE=saas");
  if (env.storageMode !== "postgres" || env.controlStorageMode !== "postgres") {
    throw new Error("SaaS backend requires PostgreSQL runtime and control storage");
  }
  if (!env.databaseUrl || !env.controlDatabaseUrl || !env.controlSecretMasterKey) {
    throw new Error("SaaS backend requires DATABASE_URL, CONTROL_DATABASE_URL and CONTROL_SECRET_MASTER_KEY");
  }
  if (env.objectStorageMode !== "s3" || !env.objectStorageBucket || !env.objectStorageEndpoint
    || !env.objectStorageAccessKeyId || !env.objectStorageSecretAccessKey) {
    throw new Error("SaaS backend requires complete S3 object storage configuration");
  }
}

async function closePartialRuntime(
  conversation: SaaSConversationRuntimeHandle | undefined,
  control: SaaSControlRuntimeHandle | undefined,
  pool: Pool | undefined,
): Promise<void> {
  await conversation?.close().catch(() => undefined);
  await conversation?.wsTickets.close().catch(() => undefined);
  await control?.close().catch(() => undefined);
  await pool?.end().catch(() => undefined);
}
