import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { ControlPlane } from "@ragsystem/backend-core/contracts/control-plane/index.js";
import type { UserId } from "@ragsystem/backend-core/identity/types.js";

import { createDaemonApplicationRuntime, type DaemonApplicationRuntime } from "./application-runtime.js";
import type { DaemonLeaderLease } from "./contracts/daemon-leader-lease.js";
import { registerBotRoutes } from "./routes/bots.js";
import { registerDaemonPlatformRoutes } from "./routes/platform.js";
import type { DaemonBotRepository } from "./contracts/bot-repository.js";

export const DAEMON_FEISHU_PLUGIN_ID = "@ragsystem/backend-plugin-daemon-feishu";

export interface DaemonFeishuPluginDependencies {
  readonly botRepository: DaemonBotRepository;
  readonly controlPlane: ControlPlane;
  readonly leaderLease?: DaemonLeaderLease;
}

export function createDaemonFeishuPlugin(dependencies: DaemonFeishuPluginDependencies): BackendPlugin {
  let application: DaemonApplicationRuntime | null = null;
  let registry: import("@ragsystem/backend-core/services/runtime/runtime-container-registry.js").RuntimeContainerRegistry | null = null;
  return {
    manifest: { id: DAEMON_FEISHU_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.applications.register((applicationContext) => {
        registry = applicationContext.registry;
        application = createDaemonApplicationRuntime({
          botRepository: dependencies.botRepository,
          registry: applicationContext.registry,
          logger: applicationContext.logger,
          ...(dependencies.leaderLease ? { leaderLease: dependencies.leaderLease } : {}),
        });
        return {
          start: () => application!.start(),
          dispose: () => {
            application?.dispose();
            application = null;
            registry = null;
          },
        };
      });
      context.routes.register("management", "/api/bots", async (app) => {
        if (!application || !registry) throw new Error("Daemon/Feishu application runtime is not initialized");
        await app.register(registerBotRoutes, {
          daemon: application.service,
          botRepository: dependencies.botRepository,
          registry,
        });
      });
      context.routes.register("platform", "/api/platform", async (app) => {
        await app.register(registerDaemonPlatformRoutes, {
          controlPlane: dependencies.controlPlane,
          botRepository: dependencies.botRepository,
        });
      });
      context.events.on("resource.changed", async (payload) => {
        if (!application || !isUserStatusChange(payload)) return;
        const botId = payload.resourceId as UserId;
        if (await dependencies.botRepository.get(botId)) await application.service.reloadBot(botId);
      });
      context.events.on("session.origins.resolve", async (payload) => {
        if (!isSessionOriginResolution(payload)) return;
        for (const bot of await dependencies.botRepository.listByTenant(payload.tenantId as import("@ragsystem/backend-core/identity/types.js").TenantId)) {
          payload.names.set(`bot:${bot.id}`, bot.displayName);
        }
      });
    },
  };
}

function isSessionOriginResolution(value: unknown): value is { tenantId: string; names: Map<string, string> } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.tenantId === "string" && item.names instanceof Map;
}

function isUserStatusChange(value: unknown): value is { resourceType: "user"; resourceId: string; change: "status" } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.resourceType === "user" && typeof item.resourceId === "string" && item.change === "status";
}
