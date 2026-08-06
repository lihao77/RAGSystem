import type {
  DeploymentApplicationResolvers,
  DeploymentRuntime,
} from "@ragsystem/backend-core/app/deployment-runtime.js";
import path from "node:path";
import { provideBackendResource, type BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import type { AppEnv } from "@ragsystem/backend-core/config/env.js";
import type { DeploymentProfile } from "@ragsystem/backend-core/identity/types.js";
import { LocalIdentityProvider, PasswordIdentityProvider, type IdentityProvider } from "@ragsystem/backend-core/services/identity/index.js";
import type { SessionTokenService } from "@ragsystem/backend-core/services/runtime/session-token-service.js";
import { createWsTicketService } from "@ragsystem/backend-core/services/runtime/ws-ticket-service.js";
import {
  createLocalFileChangeApplicationResolver,
  createLocalRequestApplicationResolvers,
  createLocalSessionFileApplicationResolver,
} from "../application/local-request-application-resolvers.js";
import { LocalTenantRuntimeRegistry } from "../tenant-runtime-registry.js";
import { TenantPaths } from "../tenant-paths.js";
import { createControlStore } from "../sqlite/control-store/index.js";
import { SqliteControlPlaneAdapter } from "../sqlite/sqlite-control-plane-adapter.js";

export interface LocalDeploymentRuntime extends DeploymentRuntime {
  readonly pluginResources: {
    readonly controlDatabase: import("node:sqlite").DatabaseSync;
  };
}

export function createLocalDeploymentRuntime(env: AppEnv): LocalDeploymentRuntime {
  if (env.deploymentMode === "saas" || env.storageMode === "postgres" || env.controlStorageMode === "postgres") {
    throw new Error("Local backend only supports SQLite control/runtime storage");
  }

  const controlStore = createControlStore(env.systemRoot);
  const controlPlane = new SqliteControlPlaneAdapter(controlStore);
  const wsTickets = createWsTicketService();
  const applications = createLocalRequestApplicationResolvers();
  const deploymentApplications: DeploymentApplicationResolvers = {
    ...applications,
    resolveSessionFileApplication: createLocalSessionFileApplicationResolver(),
    resolveFileChangeApplication: createLocalFileChangeApplicationResolver(),
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
    createRegistry: (logger, plugins) => new LocalTenantRuntimeRegistry(
      env,
      controlPlane.tenants,
      logger,
      plugins ? { runtimeOptions: { plugins } } : {},
    ),
    createIdentityProvider: async (authMode, sessionTokens) => {
      const identityProvider = createLocalIdentityProvider(authMode, controlPlane, sessionTokens);
      if (identityProvider instanceof LocalIdentityProvider) await identityProvider.initialize();
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

function validateLocalProfile(profile: DeploymentProfile): void {
  if (profile.deployment !== "local" || profile.execution !== "local") {
    throw new Error("Local backend currently requires deployment=local and execution=local");
  }
}

function createLocalIdentityProvider(
  authMode: string,
  controlPlane: SqliteControlPlaneAdapter,
  sessionTokens: SessionTokenService | undefined,
): IdentityProvider {
  if (authMode === "local") return new LocalIdentityProvider(controlPlane);
  if (authMode === "password" && sessionTokens) return new PasswordIdentityProvider(controlPlane, sessionTokens);
  if (authMode === "oidc") throw new Error("Local backend does not provide OIDC identity");
  throw new Error(`Cannot create Local identity provider for auth mode: ${authMode}`);
}
