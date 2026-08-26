import type {
  DeploymentApplicationResolvers,
  DeploymentRuntime,
} from "@ragsystem/backend-core/app/deployment-runtime.js";
import path from "node:path";
import { provideBackendResource, type BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import type { AppEnv } from "@ragsystem/backend-core/config/env.js";
import type { DeploymentProfile } from "@ragsystem/backend-core/identity/types.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "@ragsystem/backend-core/services/identity/index.js";
import { createWsTicketService } from "@ragsystem/backend-core/services/runtime/ws-ticket-service.js";
import {
  createLocalFileChangeApplicationResolver,
  createLocalRequestApplicationResolvers,
  createLocalSessionFileApplicationResolver,
  createLocalWorkspaceFileApplicationResolver,
} from "../application/local-request-application-resolvers.js";
import { SceneLocalIdentityProvider } from "../identity/scene-local-identity-provider.js";
import { LocalTenantRuntimeRegistry } from "../tenant-runtime-registry.js";
import { TenantPaths } from "../tenant-paths.js";
import { createControlStore } from "../sqlite/control-store/index.js";
import { SqliteControlPlaneAdapter } from "../sqlite/sqlite-control-plane-adapter.js";

export interface LocalDeploymentRuntime extends DeploymentRuntime {
  readonly pluginResources: {
    readonly controlDatabase: import("node:sqlite").DatabaseSync;
  };
}

export async function createLocalDeploymentRuntime(env: AppEnv): Promise<LocalDeploymentRuntime> {
  if (env.deploymentMode === "saas" || env.storageMode === "postgres" || env.controlStorageMode === "postgres") {
    throw new Error("Local backend only supports SQLite control/runtime storage");
  }

  const controlStore = createControlStore(env.systemRoot);
  const controlPlane = new SqliteControlPlaneAdapter(controlStore);
  // 必须先于 buildCoreApp 读 settings 完成：固化本地档位，同时自愈被历史
  // 安装写入污染的 system_settings（例如共用数据目录时期留下的 SaaS 配置）。
  await ensureLocalInstallation(controlPlane);
  const wsTickets = createWsTicketService();
  const applications = createLocalRequestApplicationResolvers();
  const deploymentApplications: DeploymentApplicationResolvers = {
    ...applications,
    resolveSessionFileApplication: createLocalSessionFileApplicationResolver(),
    resolveFileChangeApplication: createLocalFileChangeApplicationResolver(),
    resolveWorkspaceFileApplication: createLocalWorkspaceFileApplicationResolver(),
  };
  const hostResources: readonly BackendPluginResourceContribution[] = [
    provideBackendResource(BACKEND_HOST_RESOURCES.deployment, { kind: "local" }, "@ragsystem/backend-local"),
    provideBackendResource(BACKEND_HOST_RESOURCES.controlPlane, controlPlane, "@ragsystem/backend-local"),
    provideBackendResource(BACKEND_HOST_RESOURCES.applications, deploymentApplications, "@ragsystem/backend-local"),
    provideBackendResource(BACKEND_HOST_RESOURCES.wsTickets, wsTickets, "@ragsystem/backend-local"),
    provideBackendResource(
      BACKEND_HOST_RESOURCES.tenantDataRoot,
      (tenantId: string) => new TenantPaths(path.join(env.tenantsRoot, tenantId)).dataRoot,
      "@ragsystem/backend-local",
    ),
    provideBackendResource(BACKEND_HOST_RESOURCES.controlDatabase, controlStore.db, "@ragsystem/backend-local"),
  ];
  let closed = false;

  return {
    controlPlane,
    pluginResources: { controlDatabase: controlStore.db },
    applications: deploymentApplications,
    hostResources,
    validateProfile: validateLocalProfile,
    wsTickets,
    createRegistry: (logger, plugins, host) => new LocalTenantRuntimeRegistry(
      env,
      controlPlane.tenants,
      logger,
      {
        runtimeOptions: {
          ...(plugins ? { plugins } : {}),
          ...(host ? { lifecycleEvents: host.emitLifecycleEvent } : {}),
        },
      },
    ),
    createIdentityProvider: async (authMode) => {
      const identityProvider = createLocalIdentityProvider(authMode, controlPlane);
      await identityProvider.initialize();
      return identityProvider;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await wsTickets.close();
      await controlPlane.close();
    },
  };
}

/**
 * 本地形态免安装：启动时幂等固化部署档位并供给隐式身份（usr_local/tnt_local），
 * 前端不再出现安装向导。settings 为 upsert 语义，重复启动无副作用。
 */
async function ensureLocalInstallation(controlPlane: SqliteControlPlaneAdapter): Promise<void> {
  await controlPlane.settings.setMany({
    deployment_mode: "local",
    auth_mode: "local",
    tenancy_mode: "single",
    execution_mode: "local",
    storage_mode: "sqlite",
    ui_mode: "local",
    installed: "true",
  });
  await controlPlane.provisioning.ensureLocalIdentity({
    tenant: { id: LOCAL_TENANT_ID, displayName: "Local" },
    user: { id: LOCAL_USER_ID, displayName: "Local User", platformRole: "admin" },
    role: "owner",
  });
}

function validateLocalProfile(profile: DeploymentProfile): void {
  if (profile.deployment !== "local" || profile.execution !== "local" || profile.auth !== "local") {
    throw new Error("Local backend requires deployment=local, execution=local and auth=local (implicit identity)");
  }
}

function createLocalIdentityProvider(
  authMode: string,
  controlPlane: SqliteControlPlaneAdapter,
): SceneLocalIdentityProvider {
  if (authMode !== "local") {
    throw new Error(`Local backend locks auth to implicit local identity, got: ${authMode}`);
  }
  return new SceneLocalIdentityProvider(controlPlane);
}
