import type {
  DeploymentApplicationResolvers,
  DeploymentRuntime,
} from "@ragsystem/backend-core/app/deployment-runtime.js";
import type { BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import type { DaemonBotRepository } from "@ragsystem/backend-plugin-daemon-feishu/contracts/bot-repository.js";
import { SqliteBotRepository } from "@ragsystem/backend-plugin-daemon-feishu/storage/local/sqlite-bot-repository.js";
import type { AppEnv } from "@ragsystem/backend-core/config/env.js";
import { LocalIdentityProvider, PasswordIdentityProvider, type IdentityProvider } from "@ragsystem/backend-core/services/identity/index.js";
import type { SessionTokenService } from "@ragsystem/backend-core/services/runtime/session-token-service.js";
import { createWsTicketService } from "@ragsystem/backend-core/services/runtime/ws-ticket-service.js";
import {
  createLocalFileChangeApplicationResolver,
  createLocalRequestApplicationResolvers,
  createLocalSessionFileApplicationResolver,
} from "../application/local-request-application-resolvers.js";
import { LocalTenantRuntimeRegistry } from "../tenant-runtime-registry.js";
import { createControlStore } from "../sqlite/control-store/index.js";
import { SqliteControlPlaneAdapter } from "../sqlite/sqlite-control-plane-adapter.js";

export interface LocalDeploymentRuntime extends DeploymentRuntime {
  readonly botRepository: DaemonBotRepository;
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
  const botRepository = new SqliteBotRepository(controlStore);
  const wsTickets = createWsTicketService();
  const applications = createLocalRequestApplicationResolvers();
  const deploymentApplications: DeploymentApplicationResolvers = {
    ...applications,
    resolveSessionFileApplication: createLocalSessionFileApplicationResolver(),
    resolveFileChangeApplication: createLocalFileChangeApplicationResolver(),
  };
  const hostResources: readonly BackendPluginResourceContribution[] = [
    { pluginId: "@ragsystem/backend-local", kind: BACKEND_HOST_RESOURCES.deployment, value: { kind: "local" } },
    { pluginId: "@ragsystem/backend-local", kind: BACKEND_HOST_RESOURCES.controlPlane, value: controlPlane },
    { pluginId: "@ragsystem/backend-local", kind: BACKEND_HOST_RESOURCES.applications, value: deploymentApplications },
    { pluginId: "@ragsystem/backend-local", kind: BACKEND_HOST_RESOURCES.wsTickets, value: wsTickets },
    { pluginId: "@ragsystem/backend-local", kind: BACKEND_HOST_RESOURCES.controlDatabase, value: controlStore.db },
  ];
  let closed = false;

  return {
    controlPlane,
    botRepository,
    pluginResources: { controlDatabase: controlStore.db },
    applications: deploymentApplications,
    hostResources,
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
