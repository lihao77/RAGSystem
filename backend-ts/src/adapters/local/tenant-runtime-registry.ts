import path from "node:path";

import type { AppEnv } from "../../config/env.js";
import type { TenantDirectory } from "../../contracts/control-plane/index.js";
import type { TenantId } from "../../identity/types.js";
import type { AgentExecutionLogger } from "../../services/agent/execution/index.js";
import {
  TenantRuntimeRegistryCore,
  type TenantRuntimeRegistry as TenantRuntimeRegistryContract,
  type TenantRuntimeLease as TenantRuntimeLeaseContract,
  type TenantRuntimeActivityLease,
  type TenantRuntimeSnapshot as TenantRuntimeSnapshotContract,
  type DaemonRouteTarget,
  type RuntimeEntryState,
} from "../../services/runtime/tenant-runtime-registry.js";
import { createLocalRuntimeContainer } from "./runtime-container.js";
import type { RuntimeContainer } from "../../contracts/runtime/runtime-container.js";
import type { RuntimeContainerOptions } from "../../adapters/local/runtime-options.js";
import { TenantPaths } from "./tenant-paths.js";

export interface TenantRuntimeSnapshot extends TenantRuntimeSnapshotContract {
  dataRoot: string;
}

export type TenantRuntimeRegistry = Omit<TenantRuntimeRegistryContract<RuntimeContainer>, "snapshot"> & {
  snapshot(tenantId: string): TenantRuntimeSnapshot | null;
};
export type TenantRuntimeLease = TenantRuntimeLeaseContract<RuntimeContainer>;
export type { TenantRuntimeActivityLease, DaemonRouteTarget, RuntimeEntryState };

export interface LocalTenantRuntimeRegistryOptions {
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  runtimeOptions?: Omit<RuntimeContainerOptions, "tenantId" | "dbPath" | "dataRoot" | "logger">;
  runtimeFactory?: (options: RuntimeContainerOptions) => RuntimeContainer | Promise<RuntimeContainer>;
  prepareRuntime?: (tenantId: TenantId, runtime: RuntimeContainer) => Promise<void>;
}

/** Local deployment adapter around the shared tenant lifecycle registry. */
export class LocalTenantRuntimeRegistry extends TenantRuntimeRegistryCore<RuntimeContainer> {
  constructor(
    env: AppEnv,
    tenantDirectory?: TenantDirectory,
    logger?: AgentExecutionLogger,
    options: LocalTenantRuntimeRegistryOptions = {},
  ) {
    const runtimeFactory = options.runtimeFactory ?? createLocalRuntimeContainer;
    const runtimeOptions = options.runtimeOptions ?? {};
    super(tenantDirectory, {
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
      createRuntime: async (tenantId) => {
        const paths = new TenantPaths(path.join(env.tenantsRoot, tenantId));
        const container = await Promise.resolve(runtimeFactory({
          ...runtimeOptions,
          tenantId,
          dbPath: paths.ragsystemDbPath(),
          dataRoot: paths.dataRoot,
          ...(logger ? { logger } : {}),
        }));
        try {
          await container.backgroundTasks.initialize();
          return container;
        } catch (error) {
          container.close();
          throw error;
        }
      },
      ...(options.prepareRuntime ? { prepareRuntime: options.prepareRuntime } : {}),
      hasSession: (runtime, sessionId) => Boolean(runtime.sessionApplication.getSession(sessionId)),
      getRunningCount: (runtime) => runtime.agentExecution.listRunningTasks().count,
      onRuntimeReady: (_tenantId, runtime) => {
        runtime.backgroundTasks.setOnTaskCompleted((sessionId) => runtime.agentExecution.triggerBgNotificationRun(sessionId));
      },
      closeRuntime: (runtime) => runtime.close(),
    });
    this.tenantsRoot = env.tenantsRoot;
  }

  private readonly tenantsRoot: string;

  override snapshot(rawTenantId: string): TenantRuntimeSnapshot | null {
    const snapshot = super.snapshot(rawTenantId);
    return snapshot
      ? {
          ...snapshot,
          dataRoot: new TenantPaths(path.join(this.tenantsRoot, snapshot.tenantId)).dataRoot,
        }
      : null;
  }
}

/** Backwards-compatible name used by existing composition roots. */
export { LocalTenantRuntimeRegistry as DefaultTenantRuntimeRegistry };
