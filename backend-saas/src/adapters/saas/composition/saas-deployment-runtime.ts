import { Pool } from "pg";

import type {
  DeploymentApplicationResolvers,
  DeploymentRuntime,
} from "@ragsystem/backend-core/app/deployment-runtime.js";
import type { BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import type { AppEnv } from "@ragsystem/backend-core/config/env.js";
import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";
import type { SecretResolver } from "@ragsystem/backend-core/contracts/integrations/secret-resolver.js";
import { RuntimeExecutionApplication } from "@ragsystem/backend-core/services/agent/execution/runtime-execution-application.js";
import { PasswordIdentityProvider } from "@ragsystem/backend-core/services/identity/index.js";
import { SaaSAnalyticsApplication } from "../application/analytics/saas-analytics-application.js";
import { SaaSAgentReadApplication } from "../application/execution/saas-agent-read-application.js";
import { SaaSFileChangeApplication } from "../application/file-change/saas-file-change-application.js";
import { SaaSMonitoringApplication } from "../application/monitoring/saas-monitoring-application.js";
import { SaaSProviderApplication } from "../application/provider/saas-provider-application.js";
import { SaaSSessionApplication } from "../application/session/saas-session-application.js";
import { SaaSSessionFileApplication } from "../application/session-file/saas-session-file-application.js";
import { createSaaSControlRuntime, type SaaSControlRuntimeHandle } from "./saas-control-runtime.js";
import { createSaaSConversationRuntime, type SaaSConversationRuntimeHandle } from "./saas-conversation-runtime.js";
import { createSaaSObjectStorage } from "./saas-object-storage.js";
import { SaaSTenantRuntimeRegistry } from "./saas-tenant-runtime-registry.js";
import type { PostgresExecutor } from "../postgres/postgres-executor.js";
import type { DaemonLeaderLease } from "@ragsystem/backend-plugin-daemon-feishu/contracts/daemon-leader-lease.js";
import type { DaemonBotRepository } from "@ragsystem/backend-plugin-daemon-feishu/contracts/bot-repository.js";

export interface SaaSDeploymentRuntime extends DeploymentRuntime {
  readonly botRepository: DaemonBotRepository;
  readonly daemonLeaderLease: DaemonLeaderLease;
  readonly pluginResources: {
    database: PostgresExecutor;
    controlDatabase: Pool;
    objects: ObjectStorage;
    secrets: SecretResolver;
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
  const deploymentApplications: DeploymentApplicationResolvers = {
    resolveSessionFileApplication: (request) => new SaaSSessionFileApplication(
      conversation.createSessionFileStorage(request.identity.tenantId),
    ),
    resolveFileChangeApplication: (request) => new SaaSFileChangeApplication(
      conversation.createFileHistoryStorage(request.identity.tenantId),
    ),
    resolveProviderApplication: (request) => new SaaSProviderApplication(
      request.identity.tenantId,
      request.container.modelAdapter,
      conversation.providers,
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
  };
  const hostResources: readonly BackendPluginResourceContribution[] = [
    { pluginId: "@ragsystem/backend-saas", kind: BACKEND_HOST_RESOURCES.deployment, value: { kind: "saas" } },
    { pluginId: "@ragsystem/backend-saas", kind: BACKEND_HOST_RESOURCES.controlPlane, value: control.controlPlane },
    { pluginId: "@ragsystem/backend-saas", kind: BACKEND_HOST_RESOURCES.applications, value: deploymentApplications },
    { pluginId: "@ragsystem/backend-saas", kind: BACKEND_HOST_RESOURCES.wsTickets, value: conversation.wsTickets },
    { pluginId: "@ragsystem/backend-saas", kind: BACKEND_HOST_RESOURCES.controlDatabase, value: control.database },
    { pluginId: "@ragsystem/backend-saas", kind: BACKEND_HOST_RESOURCES.runtimeDatabase, value: conversation.pluginResources.database },
    { pluginId: "@ragsystem/backend-saas", kind: BACKEND_HOST_RESOURCES.objectStorage, value: objects },
    { pluginId: "@ragsystem/backend-saas", kind: BACKEND_HOST_RESOURCES.secrets, value: control.secretResolver },
    { pluginId: "@ragsystem/backend-saas", kind: BACKEND_HOST_RESOURCES.leaderElection, value: control.daemonLeaderLease },
  ];
  let closed = false;

  return {
    controlPlane: control.controlPlane,
    botRepository: control.botRepository,
    daemonLeaderLease: control.daemonLeaderLease,
    wsTickets: conversation.wsTickets,
    hostResources,
    pluginResources: {
      database: conversation.pluginResources.database,
      controlDatabase: control.database,
      objects,
      secrets: control.secretResolver,
    },
    applications: deploymentApplications,
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
