import type { Pool } from "pg";

import type { ControlPlane } from "@ragsystem/backend-core/contracts/control-plane/index.js";
import type { SecretResolver } from "@ragsystem/backend-core/contracts/integrations/secret-resolver.js";
import type { BackendPlugin, BackendPluginModule, BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  BACKEND_HOST_RESOURCES,
  findBackendPluginResource,
  requireBackendPluginResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";

import type { DaemonLeaderLease } from "./contracts/daemon-leader-lease.js";
import type { DaemonBotRepository } from "./contracts/bot-repository.js";
import { createDaemonFeishuPlugin, DAEMON_FEISHU_PLUGIN_ID } from "./plugin.js";
import { SqliteBotRepository, type LocalDaemonBotStore } from "./storage/local/sqlite-bot-repository.js";
import { PostgresBotRepository } from "./storage/postgres/bot-repository.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: DAEMON_FEISHU_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createInstalledDaemonFeishuPlugin();
  },
};

function createInstalledDaemonFeishuPlugin(): BackendPlugin {
  let hostResources: readonly BackendPluginResourceContribution[] | null = null;
  let botRepository: DaemonBotRepository | null = null;
  const requireHost = <Value>(kind: string): Value => {
    if (!hostResources) throw new Error("Daemon/Feishu host resources are not initialized");
    return requireBackendPluginResource<Value>(hostResources, kind);
  };
  const requireRepository = (): DaemonBotRepository => {
    if (!botRepository) throw new Error("Daemon/Feishu Bot repository is not initialized");
    return botRepository;
  };
  const base = createDaemonFeishuPlugin({
    botRepository: requireRepository,
    controlPlane: () => requireHost<ControlPlane>(BACKEND_HOST_RESOURCES.controlPlane),
    leaderLease: () => hostResources
      ? findBackendPluginResource<DaemonLeaderLease>(hostResources, BACKEND_HOST_RESOURCES.leaderElection)
      : undefined,
  });
  return {
    ...base,
    async register(context) {
      context.applications.register(({ resources }) => {
        hostResources = resources ?? [];
        const deployment = requireHost<{ kind: "local" | "saas" }>(BACKEND_HOST_RESOURCES.deployment);
        botRepository = deployment.kind === "local"
          ? new SqliteBotRepository(requireHost<LocalDaemonBotStore>(BACKEND_HOST_RESOURCES.controlStore))
          : new PostgresBotRepository(
              requireHost<Pool>(BACKEND_HOST_RESOURCES.controlDatabase),
              requireHost<SecretResolver>(BACKEND_HOST_RESOURCES.secrets),
            );
        return {
          dispose() {
            botRepository = null;
            hostResources = null;
          },
        };
      });
      await base.register(context);
    },
  };
}

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Daemon/Feishu plugin install configuration is not supported");
}
