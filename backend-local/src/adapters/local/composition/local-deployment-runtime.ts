import type { DeploymentRuntime } from "@ragsystem/backend-core/app/deployment-runtime.js";
import type { ArtifactApplication } from "@ragsystem/backend-core/contracts/artifacts/artifact-application.js";
import type { AppEnv } from "@ragsystem/backend-core/config/env.js";
import { LocalIdentityProvider, PasswordIdentityProvider, type IdentityProvider } from "@ragsystem/backend-core/services/identity/index.js";
import type { SessionTokenService } from "@ragsystem/backend-core/services/runtime/session-token-service.js";
import path from "node:path";
import { createWsTicketService } from "@ragsystem/backend-core/services/runtime/ws-ticket-service.js";
import {
  createLocalFileChangeApplicationResolver,
  createLocalKnowledgeApplicationResolver,
  createLocalRequestApplicationResolvers,
  createLocalSessionFileApplicationResolver,
} from "../application/local-request-application-resolvers.js";
import { LocalTenantRuntimeRegistry } from "../tenant-runtime-registry.js";
import { createControlStore } from "../sqlite/control-store/index.js";
import { SqliteBotRepository } from "../sqlite/sqlite-bot-repository.js";
import { SqliteControlPlaneAdapter } from "../sqlite/sqlite-control-plane-adapter.js";
import { SqliteWidgetCredentialAdapter } from "../sqlite/sqlite-widget-credential-adapter.js";
import { createWidgetCredentialStore } from "../sqlite/widget-credential-store/index.js";
import { LocalArtifactApplication } from "../application/artifact/local-artifact-application.js";
import { FilesystemArtifactService } from "../artifacts/filesystem-artifact-service.js";
import { TenantPaths } from "../tenant-paths.js";

export interface LocalDeploymentRuntime extends DeploymentRuntime {
  resolveArtifactApplicationForTenant(tenantId: string): ArtifactApplication;
}

export function createLocalDeploymentRuntime(env: AppEnv): LocalDeploymentRuntime {
  if (env.deploymentMode === "saas" || env.storageMode === "postgres" || env.controlStorageMode === "postgres") {
    throw new Error("Local backend only supports SQLite control/runtime storage");
  }

  const controlStore = createControlStore(env.systemRoot);
  const controlPlane = new SqliteControlPlaneAdapter(controlStore);
  const botRepository = new SqliteBotRepository(controlStore);
  const widgetCredentialStore = createWidgetCredentialStore(controlStore.db);
  const widgetCredentials = new SqliteWidgetCredentialAdapter(widgetCredentialStore);
  const wsTickets = createWsTicketService();
  const applications = createLocalRequestApplicationResolvers();
  let closed = false;

  return {
    controlPlane,
    botRepository,
    widgetCredentials,
    applications: {
      ...applications,
      resolveKnowledgeApplication: createLocalKnowledgeApplicationResolver(),
      resolveSessionFileApplication: createLocalSessionFileApplicationResolver(),
      resolveFileChangeApplication: createLocalFileChangeApplicationResolver(),
    },
    wsTickets,
    resolveArtifactApplicationForTenant: (tenantId) => new LocalArtifactApplication(
      new FilesystemArtifactService({ dataRoot: new TenantPaths(path.join(env.tenantsRoot, tenantId)).dataRoot }),
    ),
    createRegistry: (logger, configureHooks) => new LocalTenantRuntimeRegistry(
      env,
      controlPlane.tenants,
      logger,
      configureHooks ? { runtimeOptions: { hooks: configureHooks } } : {},
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
      await widgetCredentials.close();
      widgetCredentialStore.close();
      await controlPlane.close();
    },
  };
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
