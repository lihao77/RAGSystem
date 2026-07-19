import path from "node:path";

import type { AppEnv } from "../../config/env.js";
import type { TenantDirectory } from "../../contracts/control-plane/index.js";
import { createTenantId, type TenantId, type UserId } from "../../identity/types.js";
import type { AgentExecutionLogger } from "../agent/execution/index.js";
import { createLocalRuntimeContainer } from "../../adapters/local/runtime-container.js";
import type { RuntimeContainer, RuntimeContainerOptions } from "../../contracts/runtime-container.js";
import { TenantPaths } from "./tenant-paths.js";

/**
 * A runtime lease is deployment-agnostic. Implementations decide how a
 * runtime is located and provisioned; callers only own/release the lease.
 */
export interface RuntimeLease<TRuntime> {
  readonly tenantId: TenantId;
  readonly runtime: TRuntime;
  release(): void;
}

export interface RuntimeProvider<TRuntime> {
  acquire(tenantId: string): Promise<RuntimeLease<TRuntime>>;
}

export interface RuntimeRegistry<TRuntime> extends RuntimeProvider<TRuntime> {
  closeTenant(tenantId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/** Local runtime lease retained as the public tenant-runtime contract. */
export type TenantRuntimeLease = RuntimeLease<RuntimeContainer>;

export interface TenantRuntimeActivityLease {
  release(): void;
}

export interface TenantRuntimeSnapshot {
  tenantId: TenantId;
  state: RuntimeEntryState;
  references: number;
  webSockets: number;
  runs: number;
  lastAccessedAt: number;
  dataRoot: string;
}

export interface DaemonRouteTarget {
  tenantId: TenantId;
  botId: UserId;
}

/** Options for the local, filesystem-backed runtime registry. */
export interface LocalTenantRuntimeRegistryOptions {
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  runtimeOptions?: Omit<RuntimeContainerOptions, "tenantId" | "dbPath" | "dataRoot" | "logger">;
  runtimeFactory?: (options: RuntimeContainerOptions) => RuntimeContainer;
  prepareRuntime?: (tenantId: TenantId, runtime: RuntimeContainer) => Promise<void>;
}

/** @deprecated Use LocalTenantRuntimeRegistryOptions for local deployments. */
export type TenantRuntimeRegistryOptions = LocalTenantRuntimeRegistryOptions;

/**
 * Local registry extensions used by the HTTP/daemon routes. SaaS registries
 * can implement RuntimeRegistry without taking a dependency on these
 * filesystem/runtime-container details.
 */
export interface TenantRuntimeRegistry extends RuntimeRegistry<RuntimeContainer> {
  acquireForInspection(tenantId: string): Promise<TenantRuntimeLease>;
  acquireForSession(sessionId: string): Promise<TenantRuntimeLease | null>;
  forTenant(tenantId: string): RuntimeContainer;
  trackWebSocket(tenantId: string): TenantRuntimeActivityLease;
  trackRun(tenantId: string): TenantRuntimeActivityLease;
  snapshot(tenantId: string): TenantRuntimeSnapshot | null;
  registerRouteToken(tenantId: TenantId, botId: UserId, routeToken: string): void;
  unregisterRouteToken(routeToken: string, tenantId?: TenantId): void;
  resolveRouteToken(routeToken: string): DaemonRouteTarget | null;
  closeTenant(tenantId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export type RuntimeEntryState = "initializing" | "ready" | "closing" | "closed" | "failed";

interface RuntimeEntry {
  tenantId: TenantId;
  paths: TenantPaths;
  state: RuntimeEntryState;
  container?: RuntimeContainer;
  initPromise: Promise<RuntimeContainer>;
  references: number;
  webSockets: number;
  runs: number;
  lastAccessedAt: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export class LocalTenantRuntimeRegistry implements TenantRuntimeRegistry {
  private readonly entries = new Map<TenantId, RuntimeEntry>();
  private readonly routeTokenIndex = new Map<string, DaemonRouteTarget>();
  private readonly idleTimeoutMs: number;
  private readonly runtimeFactory: (options: RuntimeContainerOptions) => RuntimeContainer;
  private readonly runtimeOptions: Omit<RuntimeContainerOptions, "tenantId" | "dbPath" | "dataRoot" | "logger">;
  private readonly prepareRuntime: LocalTenantRuntimeRegistryOptions["prepareRuntime"];
  private readonly sweepTimer: NodeJS.Timeout;
  private closingAll = false;

  constructor(
    private readonly env: AppEnv,
    private readonly tenantDirectory?: TenantDirectory,
    private readonly logger?: AgentExecutionLogger,
    options: LocalTenantRuntimeRegistryOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.runtimeFactory = options.runtimeFactory ?? createLocalRuntimeContainer;
    this.runtimeOptions = options.runtimeOptions ?? {};
    this.prepareRuntime = options.prepareRuntime;
    const sweepIntervalMs = options.sweepIntervalMs ?? Math.max(1_000, Math.min(this.idleTimeoutMs, 30_000));
    this.sweepTimer = setInterval(() => void this.closeIdleEntries(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  async acquire(rawTenantId: string): Promise<TenantRuntimeLease> {
    return this.acquireInternal(rawTenantId, false);
  }

  async acquireForInspection(rawTenantId: string): Promise<TenantRuntimeLease> {
    return this.acquireInternal(rawTenantId, true);
  }

  private async acquireInternal(rawTenantId: string, allowSuspended: boolean): Promise<TenantRuntimeLease> {
    if (this.closingAll) {
      throw new Error("租户运行时注册表正在关闭");
    }
    const tenantId = await this.validateTenant(rawTenantId, allowSuspended);
    const entry = this.entries.get(tenantId) ?? this.createEntry(tenantId);
    const runtime = await entry.initPromise;
    await this.prepareRuntime?.(tenantId, runtime);
    if (entry.state !== "ready" || entry.container !== runtime) {
      throw new Error(`租户运行时不可用: ${tenantId}`);
    }
    entry.references += 1;
    entry.lastAccessedAt = Date.now();
    let released = false;
    return {
      tenantId,
      runtime,
      release: () => {
        if (released) return;
        released = true;
        entry.references = Math.max(0, entry.references - 1);
        entry.lastAccessedAt = Date.now();
        void this.closeEntryIfIdle(entry);
      },
    };
  }

  async acquireForSession(sessionId: string): Promise<TenantRuntimeLease | null> {
    const tenantIds = this.tenantDirectory
      ? (await this.tenantDirectory.list()).filter((tenant) => tenant.status === "active").map((tenant) => tenant.id)
      : [...this.entries.keys()];
    for (const tenantId of tenantIds) {
      const lease = await this.acquire(tenantId);
      if (lease.runtime.sessionApplication.getSession(sessionId)) return lease;
      lease.release();
    }
    return null;
  }

  forTenant(rawTenantId: string): RuntimeContainer {
    const tenantId = createTenantId(rawTenantId);
    const entry = this.entries.get(tenantId);
    if (!entry?.container || entry.state !== "ready") {
      throw new Error(`租户运行时尚未创建: ${tenantId}`);
    }
    entry.lastAccessedAt = Date.now();
    return entry.container;
  }

  trackWebSocket(tenantId: string): TenantRuntimeActivityLease {
    return this.trackActivity(tenantId, "webSockets");
  }

  trackRun(tenantId: string): TenantRuntimeActivityLease {
    return this.trackActivity(tenantId, "runs");
  }

  registerRouteToken(tenantId: TenantId, botId: UserId, routeToken: string): void {
    const existing = this.routeTokenIndex.get(routeToken);
    if (existing && (existing.tenantId !== tenantId || existing.botId !== botId)) {
      throw new Error("飞书 webhook routeToken 冲突");
    }
    this.routeTokenIndex.set(routeToken, { tenantId, botId });
  }

  unregisterRouteToken(routeToken: string, tenantId?: TenantId): void {
    const existing = this.routeTokenIndex.get(routeToken);
    if (!existing || (tenantId && existing.tenantId !== tenantId)) return;
    this.routeTokenIndex.delete(routeToken);
  }

  resolveRouteToken(routeToken: string): DaemonRouteTarget | null {
    return this.routeTokenIndex.get(routeToken) ?? null;
  }

  async closeTenant(rawTenantId: string): Promise<void> {
    const entry = this.entries.get(createTenantId(rawTenantId));
    if (entry) await this.closeEntry(entry);
  }

  async closeAll(): Promise<void> {
    if (this.closingAll) return;
    this.closingAll = true;
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.entries.values()].map((entry) => this.closeEntry(entry)));
  }

  snapshot(rawTenantId: string): TenantRuntimeSnapshot | null {
    const tenantId = createTenantId(rawTenantId);
    const entry = this.entries.get(tenantId);
    if (entry) this.refreshRunActivity(entry);
    return entry
      ? {
          tenantId,
          state: entry.state,
          references: entry.references,
          webSockets: entry.webSockets,
          runs: entry.runs,
          lastAccessedAt: entry.lastAccessedAt,
          dataRoot: entry.paths.dataRoot,
        }
      : null;
  }

  private async validateTenant(rawTenantId: string, allowSuspended: boolean): Promise<TenantId> {
    const tenantId = createTenantId(rawTenantId);
    if (this.tenantDirectory) {
      const tenant = await this.tenantDirectory.get(tenantId);
      if (!tenant) throw new Error(`租户不存在: ${tenantId}`);
      if (!allowSuspended && tenant.status !== "active") throw new Error(`租户已暂停: ${tenantId}`);
    }
    return tenantId;
  }

  private createEntry(tenantId: TenantId): RuntimeEntry {
    const paths = new TenantPaths(path.join(this.env.tenantsRoot, tenantId));
    const entry: RuntimeEntry = {
      tenantId,
      paths,
      state: "initializing",
      initPromise: Promise.resolve(undefined as never),
      references: 0,
      webSockets: 0,
      runs: 0,
      lastAccessedAt: Date.now(),
    };
    entry.initPromise = Promise.resolve()
      .then(() => {
        const container = this.runtimeFactory({
          ...this.runtimeOptions,
          tenantId,
          dbPath: paths.ragsystemDbPath(),
          dataRoot: paths.dataRoot,
          ...(this.logger ? { logger: this.logger } : {}),
        });
        return container.backgroundTasks.initialize().then(() => container);
      })
      .then((container) => {
        container.backgroundTasks.setOnTaskCompleted((sessionId) => {
          this.forTenant(tenantId).agentExecution.triggerBgNotificationRun(sessionId);
        });
        entry.container = container;
        entry.state = "ready";
        entry.lastAccessedAt = Date.now();
        return container;
      })
      .catch((error: unknown) => {
        entry.state = "failed";
        this.entries.delete(tenantId);
        throw error;
      });
    this.entries.set(tenantId, entry);
    return entry;
  }

  private trackActivity(rawTenantId: string, field: "webSockets" | "runs"): TenantRuntimeActivityLease {
    const tenantId = createTenantId(rawTenantId);
    const entry = this.entries.get(tenantId);
    if (!entry || entry.state !== "ready") {
      throw new Error(`租户运行时尚未创建: ${tenantId}`);
    }
    entry[field] += 1;
    entry.lastAccessedAt = Date.now();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        entry[field] = Math.max(0, entry[field] - 1);
        entry.lastAccessedAt = Date.now();
        void this.closeEntryIfIdle(entry);
      },
    };
  }

  private async closeIdleEntries(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((entry) => this.closeEntryIfIdle(entry)));
  }

  private async closeEntryIfIdle(entry: RuntimeEntry): Promise<void> {
    this.refreshRunActivity(entry);
    if (entry.state !== "ready" || entry.references > 0 || entry.webSockets > 0 || entry.runs > 0) return;
    if (Date.now() - entry.lastAccessedAt < this.idleTimeoutMs) return;
    await this.closeEntry(entry);
  }

  private refreshRunActivity(entry: RuntimeEntry): void {
    if (entry.container && entry.state === "ready") {
      entry.runs = entry.container.agentExecution.listRunningTasks().count;
    }
  }

  private async closeEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.state === "closed" || entry.state === "closing") return;
    entry.state = "closing";
    try {
      const container = entry.container ?? await entry.initPromise;
      container.close();
    } finally {
      entry.state = "closed";
      this.entries.delete(entry.tenantId);
    }
  }
}

/**
 * Backwards-compatible name used by existing Local-mode composition roots.
 * New code should select the deployment explicitly with
 * LocalTenantRuntimeRegistry.
 */
export { LocalTenantRuntimeRegistry as DefaultTenantRuntimeRegistry };
