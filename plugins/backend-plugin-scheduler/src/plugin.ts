import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createSchedulerApplicationRuntime, type SchedulerApplicationRuntime } from "./application-runtime.js";
import type { SchedulerLeaderLease } from "./contracts/leader-lease.js";
import type { SchedulerTaskStore } from "./contracts/task-store.js";
import { registerSchedulerRoutes } from "./routes/tasks.js";

export const SCHEDULER_PLUGIN_ID = "@ragsystem/backend-plugin-scheduler";

export type SchedulerDependencySource<Value> = Value | (() => Value);

export interface SchedulerPluginDependencies {
  readonly taskStore: SchedulerDependencySource<SchedulerTaskStore>;
  readonly leaderLease?: SchedulerDependencySource<SchedulerLeaderLease | undefined>;
}

export function createSchedulerPlugin(dependencies: SchedulerPluginDependencies): BackendPlugin {
  let application: SchedulerApplicationRuntime | null = null;
  return {
    manifest: { id: SCHEDULER_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.applications.register((applicationContext) => {
        const leaderLease = dependencies.leaderLease
          ? resolveDependency(dependencies.leaderLease)
          : undefined;
        application = createSchedulerApplicationRuntime({
          taskStore: resolveDependency(dependencies.taskStore),
          registry: applicationContext.registry,
          logger: applicationContext.logger,
          ...(leaderLease ? { leaderLease } : {}),
        });
        return {
          start: () => application!.start(),
          dispose: () => {
            application?.dispose();
            application = null;
          },
        };
      });
      context.routes.register("management", "/api/scheduler", async (app) => {
        if (!application) throw new Error("Scheduler application runtime is not initialized");
        await app.register(registerSchedulerRoutes, { scheduler: application.service });
      });
      context.events.on("session.origins.resolve", async (payload) => {
        if (!isSessionOriginResolution(payload)) return;
        const store = resolveDependency(dependencies.taskStore);
        for (const task of await store.listTasks(payload.tenantId)) {
          payload.names.set(`scheduler:${task.task_id}`, `定时任务 ${task.task_id}`);
        }
      });
    },
  };
}

function resolveDependency<Value>(source: SchedulerDependencySource<Value>): Value {
  return typeof source === "function" ? (source as () => Value)() : source;
}

function isSessionOriginResolution(value: unknown): value is { tenantId: import("@ragsystem/backend-core/identity/types.js").TenantId; names: Map<string, string> } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.tenantId === "string" && item.names instanceof Map;
}
