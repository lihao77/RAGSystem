import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import "@ragsystem/backend-core/fastify-context.js";
import type { DeploymentApplicationResolvers } from "@ragsystem/backend-core/app/deployment-runtime.js";
import type { JwtKeyRing } from "@ragsystem/backend-core/contracts/runtime/jwt-key-ring.js";
import type { WsTicketService } from "@ragsystem/backend-core/services/runtime/ws-ticket-service.js";
import { installIdentityScope } from "@ragsystem/backend-core/app/route-assembly.js";
import { registerAguiRoutes } from "@ragsystem/backend-core/routes/agent/agui.js";
import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";

import type { WidgetCredentialRepository } from "./contracts/widget-credentials.js";
import { WidgetIdentityProvider } from "./identity/widget-identity-provider.js";
import { registerWidgetAppsRoutes } from "./routes/widget-apps.js";
import { registerWidgetRoutes } from "./routes/widget.js";
import { createWidgetAuthService } from "./services/widget-auth-service.js";

export const WIDGET_PLUGIN_ID = "@ragsystem/backend-plugin-widget";

export type WidgetDependencySource<Value> = Value | (() => Value);

export interface WidgetPluginDependencies {
  readonly credentials: () => WidgetCredentialRepository | Promise<WidgetCredentialRepository>;
  readonly keyRing?: JwtKeyRing;
  readonly wsTickets: WidgetDependencySource<WsTicketService>;
  readonly applications: WidgetDependencySource<DeploymentApplicationResolvers>;
}

export function createWidgetPlugin(dependencies: WidgetPluginDependencies): BackendPlugin {
  let credentials: WidgetCredentialRepository | null = null;
  let auth: ReturnType<typeof createWidgetAuthService> | undefined;
  let identityProvider: WidgetIdentityProvider | undefined;
  let registry: RuntimeContainerRegistry | null = null;

  return {
    manifest: { id: WIDGET_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.applications.register(async (applicationContext) => {
        const createdCredentials = await dependencies.credentials();
        registry = applicationContext.registry;
        credentials = createdCredentials;
        auth = dependencies.keyRing
          ? createWidgetAuthService(dependencies.keyRing, credentials)
          : undefined;
        identityProvider = auth ? new WidgetIdentityProvider(auth) : undefined;
        return {
          start: () => credentials!.startPruning(),
          dispose: async () => {
            registry = null;
            auth = undefined;
            identityProvider = undefined;
            const current = credentials;
            credentials = null;
            await current?.close();
          },
        };
      });

      context.routes.register("management", "/api/widget/apps", async (app) => {
        if (!credentials) throw new Error("Widget application runtime is not initialized");
        await app.register(registerWidgetAppsRoutes, {
          credentials,
          enabled: Boolean(dependencies.keyRing),
        });
      });

      context.routes.register("public", "/api/widget", async (app) => {
        if (!registry) throw new Error("Widget application runtime is not initialized");
        const applications = resolveDependency(dependencies.applications);
        if (identityProvider) {
          installIdentityScope(app, {
            identityProvider,
            registry,
            mapAllIdentityErrorsToUnauthorized: true,
          });
        }
        await app.register(registerWidgetRoutes, {
          wsTickets: resolveDependency(dependencies.wsTickets),
          resolveSessionApplication: applications.resolveSessionApplication,
          ...(auth ? { widgetAuth: auth } : {}),
        });
      });

      if (dependencies.keyRing) {
        context.routes.register("public", "/api/agui", async (app) => {
          if (!registry) throw new Error("Widget application runtime is not initialized");
          if (!identityProvider) throw new Error("Widget identity provider is not initialized");
          installIdentityScope(app, {
            identityProvider,
            registry,
            mapAllIdentityErrorsToUnauthorized: true,
          });
          await app.register(registerAguiRoutes, {
            registry,
            identityProvider,
            ...resolveDependency(dependencies.applications),
          });
        });
      }

      context.events.on("session.origins.resolve", async (payload) => {
        if (!credentials || !isSessionOriginResolution(payload)) return;
        for (const widget of await credentials.apps.list(payload.tenantId as import("@ragsystem/backend-core/identity/types.js").TenantId)) {
          payload.names.set(`widget:${widget.app_key}`, widget.display_name);
        }
      });
    },
  };
}

function resolveDependency<Value>(source: WidgetDependencySource<Value>): Value {
  return typeof source === "function" ? (source as () => Value)() : source;
}

function isSessionOriginResolution(value: unknown): value is { tenantId: string; names: Map<string, string> } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.tenantId === "string" && item.names instanceof Map;
}
