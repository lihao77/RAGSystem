import type { Pool } from "pg";

import type { ControlPlane } from "@ragsystem/backend-core/contracts/control-plane/index.js";
import type { SecretResolver } from "@ragsystem/backend-core/contracts/integrations/secret-resolver.js";
import type { BackendPlugin, BackendPluginModule, BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { BackendResourceToken } from "@ragsystem/backend-core/plugins/resource-registry.js";
import {
  BACKEND_HOST_RESOURCES,
  findBackendPluginResource,
  requireBackendPluginResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";

import type { DaemonLeaderLease } from "./contracts/daemon-leader-lease.js";
import type { DaemonBotRepository } from "./contracts/bot-repository.js";
import { createDaemonFeishuPlugin, DAEMON_FEISHU_PLUGIN_ID } from "./plugin.js";
import { SqliteBotRepository } from "./storage/local/sqlite-bot-repository.js";
import { runSqliteDaemonMigrations } from "./storage/local/sqlite-migrations.js";
import { PostgresBotRepository } from "./storage/postgres/bot-repository.js";
import { runPostgresDaemonMigrations } from "./storage/postgres/migrations.js";

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
  const requireHost = <Value>(token: BackendResourceToken<unknown>): Value => {
    if (!hostResources) throw new Error("Daemon/Feishu host resources are not initialized");
    return requireBackendPluginResource<Value>(hostResources, token);
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
      context.applications.register(async ({ resources }) => {
        hostResources = resources ?? [];
        const deployment = requireHost<{ kind: "local" | "saas" }>(BACKEND_HOST_RESOURCES.deployment);
        if (deployment.kind === "local") {
          const database = requireHost<import("node:sqlite").DatabaseSync>(BACKEND_HOST_RESOURCES.controlDatabase);
          runSqliteDaemonMigrations(database);
          botRepository = new SqliteBotRepository(database);
        } else {
          const database = requireHost<Pool>(BACKEND_HOST_RESOURCES.controlDatabase);
          await runPostgresDaemonMigrations(database);
          botRepository = new PostgresBotRepository(
              database,
              requireHost<SecretResolver>(BACKEND_HOST_RESOURCES.secrets),
            );
        }
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
