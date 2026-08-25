import type { Pool } from "pg";

import type { BackendPlugin, BackendPluginModule, BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { BackendResourceToken } from "@ragsystem/backend-core/plugins/resource-registry.js";
import {
  BACKEND_HOST_RESOURCES,
  findBackendPluginResource,
  requireBackendPluginResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";

import type { SchedulerLeaderLease } from "./contracts/leader-lease.js";
import type { SchedulerTaskStore } from "./contracts/task-store.js";
import { createSchedulerPlugin, SCHEDULER_PLUGIN_ID } from "./plugin.js";
import { SqliteSchedulerTaskStore } from "./storage/local/sqlite-task-store.js";
import { runSqliteSchedulerMigrations } from "./storage/local/sqlite-migrations.js";
import { PostgresSchedulerTaskStore } from "./storage/postgres/task-store.js";
import { runPostgresSchedulerMigrations } from "./storage/postgres/migrations.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: SCHEDULER_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createInstalledSchedulerPlugin();
  },
};

function createInstalledSchedulerPlugin(): BackendPlugin {
  let hostResources: readonly BackendPluginResourceContribution[] | null = null;
  let taskStore: SchedulerTaskStore | null = null;
  const requireHost = <Value>(token: BackendResourceToken<unknown>): Value => {
    if (!hostResources) throw new Error("Scheduler host resources are not initialized");
    return requireBackendPluginResource<Value>(hostResources, token);
  };
  const requireStore = (): SchedulerTaskStore => {
    if (!taskStore) throw new Error("Scheduler task store is not initialized");
    return taskStore;
  };
  const base = createSchedulerPlugin({
    taskStore: requireStore,
    leaderLease: () => hostResources
      ? findBackendPluginResource<SchedulerLeaderLease>(hostResources, BACKEND_HOST_RESOURCES.leaderElection)
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
          runSqliteSchedulerMigrations(database);
          taskStore = new SqliteSchedulerTaskStore(database);
        } else {
          const database = requireHost<Pool>(BACKEND_HOST_RESOURCES.controlDatabase);
          await runPostgresSchedulerMigrations(database);
          taskStore = new PostgresSchedulerTaskStore(database);
        }
        return {
          dispose() {
            taskStore = null;
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
  throw new Error("Scheduler plugin install configuration is not supported");
}
