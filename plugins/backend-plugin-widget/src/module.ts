import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";

import type { DeploymentApplicationResolvers } from "@ragsystem/backend-core/app/deployment-runtime.js";
import type { BackendPlugin, BackendPluginModule, BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { BackendResourceToken } from "@ragsystem/backend-core/plugins/resource-registry.js";
import {
  BACKEND_HOST_RESOURCES,
  requireBackendPluginResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";
import type { WsTicketService } from "@ragsystem/backend-core/services/runtime/ws-ticket-service.js";

import { parseWidgetJwtKeyRing, parseWidgetJwtKeyRingValue } from "./config.js";
import { createWidgetPlugin, WIDGET_PLUGIN_ID } from "./plugin.js";
import { SqliteWidgetCredentialAdapter } from "./storage/local/sqlite-widget-credential-adapter.js";
import { createWidgetCredentialStore } from "./storage/local/widget-credential-store/index.js";
import { createPostgresWidgetCredentialRepository } from "./storage/postgres/widget-credential-repository.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: WIDGET_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    return createInstalledWidgetPlugin(parseInstallKeyRing(config));
  },
};

function createInstalledWidgetPlugin(keyRing: ReturnType<typeof parseWidgetJwtKeyRing>): BackendPlugin {
  let hostResources: readonly BackendPluginResourceContribution[] | null = null;
  const requireHost = <Value>(token: BackendResourceToken<unknown>): Value => {
    if (!hostResources) throw new Error("Widget host resources are not initialized");
    return requireBackendPluginResource<Value>(hostResources, token);
  };
  const base = createWidgetPlugin({
    credentials: () => {
      const deployment = requireHost<{ kind: "local" | "saas" }>(BACKEND_HOST_RESOURCES.deployment);
      if (deployment.kind === "local") {
        return new SqliteWidgetCredentialAdapter(
          createWidgetCredentialStore(requireHost<DatabaseSync>(BACKEND_HOST_RESOURCES.controlDatabase)),
        );
      }
      return createPostgresWidgetCredentialRepository({
        pool: requireHost<Pool>(BACKEND_HOST_RESOURCES.controlDatabase),
      });
    },
    ...(keyRing ? { keyRing } : {}),
    wsTickets: () => requireHost<WsTicketService>(BACKEND_HOST_RESOURCES.wsTickets),
    applications: () => requireHost<DeploymentApplicationResolvers>(BACKEND_HOST_RESOURCES.applications),
  });
  return {
    ...base,
    async register(context) {
      context.applications.register(({ resources }) => {
        hostResources = resources ?? [];
        return {
          dispose() {
            hostResources = null;
          },
        };
      });
      await base.register(context);
    },
  };
}

function parseInstallKeyRing(config: unknown) {
  if (config === undefined || config === null) return parseWidgetJwtKeyRing(process.env.WIDGET_JWT_KEY_RING);
  if (typeof config === "string") return parseWidgetJwtKeyRing(config);
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Widget plugin configuration must be an object");
  }
  const record = config as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "jwtKeyRing");
  if (unknownKeys.length > 0) throw new Error(`Unknown Widget plugin configuration: ${unknownKeys.join(", ")}`);
  if (record.jwtKeyRing === undefined || record.jwtKeyRing === null) {
    return parseWidgetJwtKeyRing(process.env.WIDGET_JWT_KEY_RING);
  }
  return typeof record.jwtKeyRing === "string"
    ? parseWidgetJwtKeyRing(record.jwtKeyRing)
    : parseWidgetJwtKeyRingValue(record.jwtKeyRing);
}
